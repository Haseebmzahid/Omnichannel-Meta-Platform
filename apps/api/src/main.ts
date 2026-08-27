import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';
import { GlobalExceptionFilter } from './common/http-exception.filter';
import { logger } from './logging/logger';
import { NestPinoLogger } from './logging/nest-logger.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new NestPinoLogger() });
  app.useGlobalFilters(new GlobalExceptionFilter());

  await app.listen(config.PORT);
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'API listening');
}

bootstrap();
