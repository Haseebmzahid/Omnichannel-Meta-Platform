import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { decryptCredential } from '../../common/crypto/credential-encryption';
import { PrismaService } from '../../prisma/prisma.service';

export interface InstagramCredentials {
  accessToken: string;
  accountId: string;
  username?: string;
  clinicId: string;
}

/**
 * In-memory runtime cache for active Instagram credentials.
 *
 * PostgreSQL (`channel_credentials` table) is the persistent source of truth.
 * On application startup (onModuleInit), credentials are read from the database
 * and decrypted into this cache. If no database record is found, it falls back
 * to the INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_ACCOUNT_ID environment variables.
 *
 * When an OAuth callback successfully completes, the database is updated with
 * the encrypted Page Access Token and this cache is immediately updated.
 */
@Injectable()
export class InstagramCredentialStore implements OnModuleInit {
  private readonly logger = new Logger(InstagramCredentialStore.name);

  private cachedAccessToken?: string;
  private cachedAccountId?: string;
  private cachedUsername?: string;
  private cachedClinicId?: string;

  constructor(
    private readonly prisma?: PrismaService,
    private readonly fallbackAccessToken?: string,
    private readonly fallbackAccountId?: string,
    private readonly fallbackClinicId?: string,
    private readonly encryptionKey?: string,
  ) {
    // Initialize with fallback config so synchronous access before onModuleInit works
    this.cachedAccessToken = fallbackAccessToken;
    this.cachedAccountId = fallbackAccountId;
    this.cachedClinicId = fallbackClinicId;
  }

  async onModuleInit(): Promise<void> {
    await this.loadCredentials();
  }

  async loadCredentials(): Promise<void> {
    if (!this.prisma || !this.fallbackClinicId) {
      return;
    }

    try {
      const credential = await this.prisma.channelCredential.findFirst({
        where: {
          channelKey: 'INSTAGRAM',
          clinicId: this.fallbackClinicId,
        },
      });

      if (credential) {
        try {
          const decryptedToken = decryptCredential(credential.accessToken, this.encryptionKey);
          this.cachedAccessToken = decryptedToken;
          this.cachedAccountId = credential.accountRef;
          this.cachedUsername = credential.accountName ?? undefined;
          this.cachedClinicId = credential.clinicId;
          this.logger.log(`Loaded Instagram credentials for account ${credential.accountRef} from database`);
          return;
        } catch {
          this.logger.warn(
            'Failed to decrypt stored Instagram credential from database. Falling back to environment variables.',
          );
        }
      } else {
        this.logger.log('No Instagram credential found in database. Using environment variable fallback if configured.');
      }
    } catch {
      this.logger.warn('Failed to query database for Instagram credentials. Falling back to environment variables.');
    }

    // Fall back to environment variables
    this.cachedAccessToken = this.fallbackAccessToken;
    this.cachedAccountId = this.fallbackAccountId;
    this.cachedClinicId = this.fallbackClinicId;
  }

  setCredentials(creds: InstagramCredentials): void {
    this.cachedAccessToken = creds.accessToken;
    this.cachedAccountId = creds.accountId;
    this.cachedUsername = creds.username;
    this.cachedClinicId = creds.clinicId;
    this.logger.log(`Runtime Instagram credential cache updated for account ${creds.accountId}`);
  }

  getAccessToken(): string | undefined {
    return this.cachedAccessToken;
  }

  getAccountId(): string | undefined {
    return this.cachedAccountId;
  }

  getUsername(): string | undefined {
    return this.cachedUsername;
  }

  getClinicId(): string | undefined {
    return this.cachedClinicId;
  }
}
