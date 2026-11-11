import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { LocalNewsProvider } from './local-news.provider';
import { NEWS_PROVIDER, NewsProvider } from './news.types';
import { RssNewsProvider } from './rss-news.provider';
import { SourceCredibilityService } from './source-credibility.service';

@Module({
  providers: [
    SourceCredibilityService,
    {
      provide: NEWS_PROVIDER,
      inject: [APP_CONFIG, SourceCredibilityService],
      useFactory: (config: AppConfig, credibility: SourceCredibilityService): NewsProvider =>
        config.newsProvider === 'rss'
          ? new RssNewsProvider(credibility)
          : new LocalNewsProvider(config.newsCorpusPath, credibility, config.localNewsFailFirstN),
    },
  ],
  exports: [NEWS_PROVIDER, SourceCredibilityService],
})
export class NewsModule {}
