import { Injectable } from '@nestjs/common';
import { encryptCredential } from '../../common/crypto/credential-encryption';
import { logger } from '../../logging/logger';
import { PrismaService } from '../../prisma/prisma.service';
import { InstagramOAuthFailedException, InstagramOAuthNotConfiguredException } from './instagram.errors';
import { InstagramCredentialStore } from './instagram-credential-store.service';

export interface InstagramOAuthResult {
  success: true;
  tokenObtained: boolean;
  instagramAccountId: string;
  instagramUsername?: string;
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

    const tokenParams = new URLSearchParams({
      client_id: this.appId,
      client_secret: this.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: effectiveRedirectUri,
      code,
    });

    let tokenRes: Response;
    try {
      tokenRes = await this.fetchImpl('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams.toString(),
      });
    } catch {
      logger.error('Instagram OAuth: network error reaching Instagram token endpoint');
      throw new InstagramOAuthFailedException('Could not reach Instagram for token exchange.');
    }

    if (!tokenRes.ok) {
      logger.warn({ status: tokenRes.status }, 'Instagram OAuth token exchange failed');
      throw new InstagramOAuthFailedException('Meta rejected the authorization request.');
    }

    const tokenData = (await tokenRes.json()) as { access_token?: string };
    const shortLivedToken = tokenData.access_token;
    if (!shortLivedToken) throw new InstagramOAuthFailedException('Meta did not return an access token.');

    let userToken = shortLivedToken;
    try {
      const exchangeUrl = new URL('https://graph.instagram.com/access_token');
      exchangeUrl.searchParams.set('grant_type', 'ig_exchange_token');
      exchangeUrl.searchParams.set('client_secret', this.appSecret);
      exchangeUrl.searchParams.set('access_token', shortLivedToken);
      const exchangeRes = await this.fetchImpl(exchangeUrl.toString(), {
        method: 'GET',
      });
      if (exchangeRes.ok) {
        const exchangeData = (await exchangeRes.json()) as {
          access_token?: string;
        };
        if (exchangeData.access_token) userToken = exchangeData.access_token;
      } else {
        logger.warn(
          { status: exchangeRes.status },
          'Instagram OAuth long-lived token exchange failed; using short-lived token',
        );
      }
    } catch {
      logger.warn('Instagram OAuth: long-lived token exchange failed; using short-lived token');
    }

    const identityUrl = new URL(`https://graph.instagram.com/${this.apiVersion}/me`);
    identityUrl.searchParams.set('fields', 'id,username');

    let identityRes: Response;
    try {
      identityRes = await this.fetchImpl(identityUrl.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${userToken}` },
      });
    } catch {
      logger.error('Instagram OAuth: network error querying authenticated Instagram user');
      throw new InstagramOAuthFailedException('Failed to retrieve the authenticated Instagram account.');
    }

    if (!identityRes.ok) {
      logger.warn({ status: identityRes.status }, 'Instagram OAuth account discovery failed');
      throw new InstagramOAuthFailedException('Meta account discovery failed.');
    }

    const identity = (await identityRes.json()) as {
      id?: string;
      user_id?: string;
      username?: string;
    };
    const instagramAccountId = identity.id ?? identity.user_id;
    if (!instagramAccountId) {
      throw new InstagramOAuthFailedException('Meta did not return an Instagram professional account ID.');
    }

    if (!this.prisma || !this.credentialStore || !this.configuredClinicId) {
      throw new InstagramOAuthNotConfiguredException(
        'Instagram OAuth credential persistence requires database, runtime store, and INSTAGRAM_CLINIC_ID configuration.',
      );
    }

    try {
      const clinicId = this.configuredClinicId;
      const encryptedToken = encryptCredential(userToken, this.encryptionKey);
      await this.prisma.channelCredential.upsert({
        where: { clinicId_channelKey: { clinicId, channelKey: 'INSTAGRAM' } },
        create: {
          clinicId,
          channelKey: 'INSTAGRAM',
          accountRef: instagramAccountId,
          accountName: identity.username ?? null,
          accessToken: encryptedToken,
          metadata: { connectedAt: new Date().toISOString() },
        },
        update: {
          accountRef: instagramAccountId,
          accountName: identity.username ?? null,
          accessToken: encryptedToken,
          metadata: { updatedAt: new Date().toISOString() },
        },
      });

      this.credentialStore.setCredentials({
        accessToken: userToken,
        accountId: instagramAccountId,
        username: identity.username,
        clinicId,
      });
      logger.info(
        { clinicId, accountId: instagramAccountId },
        'Instagram OAuth credentials encrypted, persisted, and cached',
      );
    } catch {
      logger.error('Instagram OAuth: failed to persist credentials to database');
      throw new InstagramOAuthFailedException('Failed to persist Instagram credentials to database.');
    }

    return {
      success: true,
      tokenObtained: true,
      instagramAccountId,
      instagramUsername: identity.username,
      persisted: true,
      message: 'Instagram Professional Account successfully identified and authenticated.',
    };
  }
}
