import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Icon, Logo, Select } from '@design';
import type { IconName } from '@design';
import { fetchPublicConfig, type PublicConfig } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import './pages.css';

const TITLE_TEXT = 'OpenPrism is Here';
const FEATURE_KEYS = ['completion', 'vision', 'plot', 'search', 'agent', 'review'] as const;
const AUTO_INTERVAL = 4000;

const FEATURE_ICONS: Record<(typeof FEATURE_KEYS)[number], IconName> = {
  completion: 'sparkles',
  vision: 'image',
  plot: 'bar-chart',
  search: 'search',
  agent: 'bot',
  review: 'check-circle',
};

export default function LandingPage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { state } = useAuth();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  useEffect(() => { void fetchPublicConfig().then(setConfig); }, []);
  // Signed-out visitors of an invitation-only site are offered sign-in, not sign-up (v0.1.2).
  const closed = state.status !== 'user' && config?.registration === 'invite';
  const [charCount, setCharCount] = useState(0);
  const [activeFeature, setActiveFeature] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    if (charCount >= TITLE_TEXT.length) return;
    const timer = setTimeout(() => setCharCount((c) => c + 1), 90);
    return () => clearTimeout(timer);
  }, [charCount]);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      setActiveFeature((i) => (i + 1) % FEATURE_KEYS.length);
    }, AUTO_INTERVAL);
    return () => clearInterval(timerRef.current);
  }, []);

  const selectFeature = (i: number) => {
    setActiveFeature(i);
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setActiveFeature((prev) => (prev + 1) % FEATURE_KEYS.length);
    }, AUTO_INTERVAL);
  };

  return (
    <div className="lp">
      {/* Top bar: logo + language selector */}
      <header className="lp-top">
        <Logo />
        <div className="op-fill" />
        <Select
          size="sm"
          ghost
          icon="languages"
          ariaLabel={t('Language')}
          value={i18n.language === 'en-US' ? 'en-US' : 'zh-CN'}
          options={[
            { value: 'zh-CN', label: t('中文') },
            { value: 'en-US', label: t('English') },
          ]}
          onChange={(val) => { void i18n.changeLanguage(val); }}
        />
      </header>

      {/* Hero section */}
      <section className="lp-hero">
        {/* Announcement banner */}
        <div className="lp-announce">
          <span>{t('landing.announce')}</span>
          <a href="https://github.com/OpenDCAI" target="_blank" rel="noopener noreferrer">
            GitHub
            <Icon name="arrow-up-right" />
          </a>
        </div>

        {/* Main title with typewriter effect */}
        <h1 className="lp-title" aria-label={TITLE_TEXT}>
          {TITLE_TEXT.split('').map((ch, i) => (
            <span
              key={i}
              aria-hidden="true"
              className={i < 9 ? 'lp-title-strong' : 'lp-title-soft'}
              style={{ opacity: i < charCount ? 1 : 0, transition: 'opacity var(--dur-fast) var(--ease-out)' }}
            >
              {ch}
            </span>
          ))}
          <span className="lp-cursor" aria-hidden="true" />
        </h1>

        {/* Subtitle */}
        <p className="lp-subtitle" dangerouslySetInnerHTML={{ __html: t('landing.subtitle') }} />

        {/* CTA */}
        <Button variant="primary" size="lg" iconEnd="chevron-right" onClick={() => navigate(closed ? '/login' : '/projects')}>
          {closed ? t('Sign in') : t('landing.startWriting')}
        </Button>
        {closed && <p className="lp-invite-note">{t('Access is by invitation.')}{config?.contactEmail && <> <a href={`mailto:${config.contactEmail}`}>{config.contactEmail}</a></>}</p>}

        {/* Feature badges */}
        <div className="lp-badges">
          <Badge icon="sparkles">{t('landing.featureAI')}</Badge>
          <Badge icon="image">{t('landing.featureVision')}</Badge>
          <Badge icon="bar-chart">{t('landing.featurePlot')}</Badge>
          <Badge icon="search">{t('landing.featureSearch')}</Badge>
        </div>
      </section>

      {/* Feature carousel */}
      <section className="lp-features">
        <div className="op-tabs lp-tabs" role="tablist">
          {FEATURE_KEYS.map((key, i) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`lp-tab-${key}`}
              aria-selected={activeFeature === i}
              aria-controls={`lp-panel-${key}`}
              className="op-tab"
              onClick={() => selectFeature(i)}
            >
              {t(`landing.feat.${key}.tab`)}
            </button>
          ))}
        </div>

        <div className="lp-track-wrap">
          <div className="lp-track" style={{ transform: `translateX(-${activeFeature * 100}%)` }}>
            {FEATURE_KEYS.map((key, i) => (
              <div
                className="lp-card"
                key={key}
                id={`lp-panel-${key}`}
                role="tabpanel"
                aria-labelledby={`lp-tab-${key}`}
                aria-hidden={activeFeature !== i}
              >
                <div className="lp-card-icon">
                  <Icon name={FEATURE_ICONS[key]} />
                </div>
                <h3>{t(`landing.feat.${key}.title`)}</h3>
                <p>{t(`landing.feat.${key}.desc`)}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="lp-dots">
          {FEATURE_KEYS.map((key, i) => (
            <button
              key={key}
              type="button"
              className="lp-dot"
              aria-label={t(`landing.feat.${key}.tab`)}
              aria-current={activeFeature === i ? 'true' : undefined}
              onClick={() => selectFeature(i)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
