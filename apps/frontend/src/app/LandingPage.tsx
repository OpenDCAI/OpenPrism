import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const TITLE_TEXT = 'OpenPrism is Here';
const FEATURE_KEYS = ['completion', 'vision', 'plot', 'search', 'agent', 'review'] as const;
const AUTO_INTERVAL = 4000;

export default function LandingPage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [charCount, setCharCount] = useState(0);
  const [activeFeature, setActiveFeature] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const [langDropdownOpen, setLangDropdownOpen] = useState(false);

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
    <div className="landing-page">
      {/* Top language selector */}
      <div className="landing-top-bar">
        <div className="ios-select-wrapper">
          <button className="ios-select-trigger" onClick={() => setLangDropdownOpen(!langDropdownOpen)}>
            <span>{i18n.language === 'en-US' ? t('English') : t('中文')}</span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={langDropdownOpen ? 'rotate' : ''}>
              <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {langDropdownOpen && (
            <div className="ios-dropdown dropdown-down">
              {([['zh-CN', t('中文')], ['en-US', t('English')]] as [string, string][]).map(([val, label]) => (
                <div key={val} className={`ios-dropdown-item ${i18n.language === val ? 'active' : ''}`} onClick={() => { i18n.changeLanguage(val); setLangDropdownOpen(false); }}>
                  {label}
                  {i18n.language === val && (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Hero section */}
      <section className="landing-hero">
        {/* Announcement banner */}
        <div className="landing-announce">
          <span className="landing-announce-text">
            {t('landing.announce')}
          </span>
          <a
            className="landing-announce-link"
            href="https://github.com/OpenDCAI"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub &rarr;
          </a>
        </div>

        {/* Main title with typewriter effect */}
        <h1 className="landing-title">
          {TITLE_TEXT.split('').map((ch, i) => (
            <span
              key={i}
              className={
                i < 9
                  ? 'landing-title-accent'
                  : 'landing-title-dark'
              }
              style={{
                opacity: i < charCount ? 1 : 0,
                transition: 'opacity 0.15s ease',
              }}
            >
              {ch}
            </span>
          ))}
          <span className="landing-cursor" />
        </h1>

        {/* Subtitle */}
        <p
          className="landing-subtitle"
          dangerouslySetInnerHTML={{ __html: t('landing.subtitle') }}
        />

        {/* CTA buttons */}
        <div className="landing-cta">
          <button
            className="landing-btn-primary"
            onClick={() => navigate('/projects')}
          >
            {t('landing.startWriting')} &rarr;
          </button>
          <button
            className="landing-btn-secondary"
            onClick={() => navigate('/templates')}
          >
            {t('打开模板库')}
          </button>
        </div>

        {/* Feature badges */}
        <div className="landing-badges">
          <div className="landing-badge">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
            {t('landing.featureAI')}
          </div>
          <div className="landing-badge">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
            {t('landing.featureVision')}
          </div>
          <div className="landing-badge">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
            {t('landing.featurePlot')}
          </div>
          <div className="landing-badge">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            {t('landing.featureSearch')}
          </div>
        </div>
      </section>

      {/* Feature carousel */}
      <section className="landing-carousel">
        <div className="carousel-tabs">
          {FEATURE_KEYS.map((key, i) => (
            <button
              key={key}
              className={`carousel-tab ${activeFeature === i ? 'active' : ''}`}
              onClick={() => selectFeature(i)}
            >
              {t(`landing.feat.${key}.tab`)}
            </button>
          ))}
        </div>

        <div className="carousel-track-wrapper">
          <div
            className="carousel-track"
            style={{ transform: `translateX(-${activeFeature * 100}%)` }}
          >
            {FEATURE_KEYS.map((key) => (
              <div className="carousel-card" key={key}>
                <div className="carousel-card-icon">
                  <FeatureIcon name={key} />
                </div>
                <h3 className="carousel-card-title">
                  {t(`landing.feat.${key}.title`)}
                </h3>
                <p className="carousel-card-desc">
                  {t(`landing.feat.${key}.desc`)}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="carousel-dots">
          {FEATURE_KEYS.map((_, i) => (
            <button
              key={i}
              className={`carousel-dot ${activeFeature === i ? 'active' : ''}`}
              onClick={() => selectFeature(i)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function FeatureIcon({ name }: { name: string }) {
  const props = { width: 32, height: 32, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (name) {
    case 'completion':
      return <svg {...props}><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>;
    case 'vision':
      return <svg {...props}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>;
    case 'plot':
      return <svg {...props}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>;
    case 'search':
      return <svg {...props}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
    case 'agent':
      return <svg {...props}><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/></svg>;
    case 'review':
      return <svg {...props}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>;
    default:
      return null;
  }
}
