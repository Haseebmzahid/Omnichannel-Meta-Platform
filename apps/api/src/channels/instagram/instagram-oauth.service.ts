import { Injectable } from '@nestjs/common';
import { encryptCredential } from '../../common/crypto/credential-encryption';
import { logger } from '../../logging/logger';
import { PrismaService } from '../../prisma/prisma.service';
import { InstagramOAuthFailedException, InstagramOAuthNotConfiguredException } from './instagram.errors';
import { InstagramCredentialStore } from './instagram-credential-store.service';

export interface InstagramOAuthResult {
  success: true;
  tokenObtained: boolean;
  instagramAccountId?: string;
  instagramUsername?: string;
  pageId?: string;
  pageName?: string;
  persisted: boolean;
  message: string;
}

@Injectable()
export class InstagramOAuthService {
  constructor(
    private readonly appId: string | undefined,
    private readonly appSecret: string | undefined,
    private readonly redirectUri: string | undefined,
    private readonly apiVersion: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly prisma?: PrismaService,
    private readonly credentialStore?: InstagramCredentialStore,
    private readonly configuredClinicId?: string,
    private readonly encryptionKey?: string,
  ) {}

  async exchangeCode(code: string, fallbackRedirectUri?: string): Promise<InstagramOAuthResult> {
    let persisted = false;
    if (!this.appId || !this.appSecret) {
      throw new InstagramOAuthNotConfiguredException(
        'INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET must be configured to use Instagram OAuth.',
      );
    }

    const effectiveRedirectUri = this.redirectUri || fallbackRedirectUri;
    if (!effectiveRedirectUri) {
      throw new InstagramOAuthNotConfiguredException(
        'Redirect URI must be configured via INSTAGRAM_OAUTH_REDIRECT_URI or inferrable from request.',
      );
    }

    // Step 1: Exchange authorization code for short-lived User Access Token.
    // Use POST with URLSearchParams to keep credentials out of query strings and access logs.
    const tokenUrl = `https://graph.facebook.com/${this.apiVersion}/oauth/access_token`;
    const tokenParams = new URLSearchParams({
      client_id: this.appId,
      client_secret: this.appSecret,
      redirect_uri: effectiveRedirectUri,
      code,
    });

    let tokenRes: Response;
    try {
      tokenRes = await this.fetchImpl(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams.toString(),
      });
    } catch {
      logger.error('Instagram OAuth: network error reaching Graph API for token exchange');
      throw new InstagramOAuthFailedException('Could not reach Meta Graph API for token exchange.');
    }

    if (!tokenRes.ok) {
      logger.warn({ status: tokenRes.status }, 'Instagram OAuth token exchange failed');
      throw new InstagramOAuthFailedException('Meta rejected the authorization request.');
    }

    const tokenData = (await tokenRes.json()) as { access_token?: string };
    const shortLivedToken = tokenData.access_token;
    if (!shortLivedToken) {
      throw new InstagramOAuthFailedException('Meta did not return an access token.');
    }

    // Step 2: Attempt to exchange for a long-lived User Access Token (60 days).
    let userToken = shortLivedToken;
    let pageAccessToken = shortLivedToken;
    try {
      const exchangeParams = new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: this.appId,
        client_secret: this.appSecret,
        fb_exchange_token: shortLivedToken,
      });

      const exchangeRes = await this.fetchImpl(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: exchangeParams.toString(),
      });

      if (exchangeRes.ok) {
        const exchangeData = (await exchangeRes.json()) as { access_token?: string };
        if (exchangeData.access_token) {
          userToken = exchangeData.access_token;
        }
      }
    } catch {
      logger.warn('Instagram OAuth: long-lived token exchange failed, using standard token');
    }

    // Step 3: Discover managed Facebook Pages and linked Instagram Professional Accounts.
    const accountsUrl = new URL(`https://graph.facebook.com/${this.apiVersion}/me/accounts`);
    accountsUrl.searchParams.set('fields', 'id,name,access_token,instagram_business_account{id,username}');

    let accountsRes: Response;
    try {
      accountsRes = await this.fetchImpl(accountsUrl.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${userToken}` },
      });
    } catch {
      logger.error('Instagram OAuth: network error querying /me/accounts');
      throw new InstagramOAuthFailedException('Failed to discover linked Instagram account from Meta.');
    }

    let instagramAccountId: string | undefined;
    let instagramUsername: string | undefined;
    let pageId: string | undefined;
    let pageName: string | undefined;

    if (accountsRes.ok) {
      const accountsJson = (await accountsRes.json()) as {
        data?: Array<{
          id: string;
          name: string;
          access_token?: string;
          instagram_business_account?: {
            id: string;
            username?: string;
          };
        }>;
      };

      const pages = accountsJson.data ?? [];
      const linkedPage = pages.find((p) => Boolean(p.instagram_business_account?.id));

      if (linkedPage) {
        pageId = linkedPage.id;
        pageName = linkedPage.name;
        instagramAccountId = linkedPage.instagram_business_account?.id;
        instagramUsername = linkedPage.instagram_business_account?.username;
        if (linkedPage.access_token) {
          pageAccessToken = linkedPage.access_token;
        }
      } else if (pages.length > 0) {
        // Facebook Page exists but no Instagram account is linked yet
        pageId = pages[0]?.id;
        pageName = pages[0]?.name;
        if (pages[0]?.access_token) {
          pageAccessToken = pages[0].access_token;
        }
      }
    } else {
      logger.warn({ status: accountsRes.status }, 'Instagram OAuth account discovery failed');
      throw new InstagramOAuthFailedException('Meta account discovery failed.');
    }

    if (!instagramAccountId) {
      throw new InstagramOAuthFailedException(
        'No linked Instagram Professional Account was found on the connected Facebook Page.',
      );
    }

    // Step 4: Persist encrypted Page Access Token and account details to PostgreSQL (persistent source of truth),
    // and immediately update the in-memory runtime cache.
    if (!this.prisma || !this.credentialStore || !this.configuredClinicId) {
      throw new InstagramOAuthNotConfiguredException(
        'Instagram OAuth credential persistence requires database, runtime store, and INSTAGRAM_CLINIC_ID configuration.',
      );
    }

    if (instagramAccountId) {
      try {
        const clinicId = this.configuredClinicId;
          const encryptedToken = encryptCredential(pageAccessToken, this.encryptionKey);
          await this.prisma.channelCredential.upsert({
            where: {
              clinicId_channelKey: {
                clinicId,
                channelKey: 'INSTAGRAM',
              },
            },
            create: {
              clinicId,
              channelKey: 'INSTAGRAM',
              accountRef: instagramAccountId,
              accountName: instagramUsername ?? pageName ?? null,
              accessToken: encryptedToken,
              metadata: {
                pageId,
                pageName,
                connectedAt: new Date().toISOString(),
              },
            },
            update: {
              accountRef: instagramAccountId,
              accountName: instagramUsername ?? pageName ?? null,
              accessToken: encryptedToken,
              metadata: {
                pageId,
                pageName,
                updatedAt: new Date().toISOString(),
              },
            },
          });
          persisted = true;

          this.credentialStore.setCredentials({
              accessToken: pageAccessToken,
              accountId: instagramAccountId,
              username: instagramUsername,
              clinicId,
            });
          logger.info({ clinicId, accountId: instagramAccountId }, 'Instagram OAuth credentials encrypted, persisted, and cached');
      } catch (dbErr) {
        logger.error('Instagram OAuth: failed to persist credentials to database');
        throw new InstagramOAuthFailedException('Failed to persist Instagram credentials to database.');
      }
    }

    return {
      success: true,
      tokenObtained: true,
      instagramAccountId,
      instagramUsername,
      pageId,
      pageName,
      persisted,
      message: 'Instagram Professional Account successfully identified and authenticated.',
    };
  }
}
