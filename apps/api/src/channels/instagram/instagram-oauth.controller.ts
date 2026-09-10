import { BadRequestException, Controller, Get, HttpCode, HttpStatus, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { InstagramOAuthResult, InstagramOAuthService } from './instagram-oauth.service';

@Controller('auth/instagram')
export class InstagramOAuthController {
  constructor(private readonly oauthService: InstagramOAuthService) {}

  @Get('callback')
  @HttpCode(HttpStatus.OK)
  async handleCallback(
    @Query('code') code?: string,
    @Query('error') error?: string,
    @Query('error_description') _errorDescription?: string,
    @Req() req?: Request,
  ): Promise<InstagramOAuthResult> {
    if (error) {
      throw new BadRequestException('Meta OAuth authorization failed. Please restart the connection flow.');
    }

    if (!code) {
      throw new BadRequestException('Authorization code is missing from Meta callback query.');
    }

    // Determine request-based callback URL as fallback if redirectUri is not explicitly configured
    let fallbackRedirectUri: string | undefined;
    if (req) {
      const protocol = req.headers['x-forwarded-proto']?.toString() || req.protocol || 'https';
      const host = req.headers['x-forwarded-host']?.toString() || req.get('host');
      if (host) {
        fallbackRedirectUri = `${protocol}://${host}/auth/instagram/callback`;
      }
    }

    return this.oauthService.exchangeCode(code, fallbackRedirectUri);
  }
}
