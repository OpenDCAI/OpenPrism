import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { createProject, listTemplates } from '../api/client';
import type { TemplateCategory, TemplateMeta } from '../api/client';

type SortKey = 'featured' | 'name' | 'category';

const FALLBACK_CATEGORIES: TemplateCategory[] = [
  { id: 'all', label: '全部', labelEn: 'All' },
  { id: 'nlp', label: '自然语言处理', labelEn: 'NLP' },
  { id: 'vision', label: '计算机视觉', labelEn: 'Computer Vision' },
  { id: 'ml', label: '机器学习', labelEn: 'Machine Learning' },
  { id: 'ai', label: '人工智能', labelEn: 'AI' },
  { id: 'data', label: '数据挖掘与检索', labelEn: 'Data & Retrieval' },
  { id: 'journal', label: '期刊', labelEn: 'Journals' },
  { id: 'preprint', label: '预印本', labelEn: 'Preprint' }
];

const HIGHLIGHTS: Record<string, string[]> = {
  acl: ['NLP', 'single-column', 'review/final'],
  cvpr: ['Vision', 'two-column', 'submission shell'],
  icml: ['ML', 'APA-style refs', 'author-year'],
  neurips: ['Checklist', 'official style', 'preprint-safe'],
  aistats: ['PMLR', 'sample paper', 'supplement'],
  uai: ['Probabilistic', 'official class', 'conference'],
  eccv: ['Springer', 'LNCS', 'vision'],
  ijcv: ['Springer Nature', 'journal', 'article class']
};

export default function TemplateLibraryPage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [categories, setCategories] = useState<TemplateCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [featuredOnly, setFeaturedOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('featured');
  const [selectedId, setSelectedId] = useState<string>('');
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    listTemplates()
      .then((res) => {
        if (!active) return;
        setTemplates(res.templates || []);
        setCategories(res.categories?.length ? res.categories : FALLBACK_CATEGORIES);
        setSelectedId((prev) => prev || res.templates?.[0]?.id || '');
      })
      .catch((err) => {
        if (!active) return;
        setStatus(t('模板加载失败: {{error}}', { error: String(err) }));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [t]);

  const visibleTemplates = useMemo(() => {
    let list = [...templates];
    if (category !== 'all') list = list.filter((tpl) => tpl.category === category);
    if (featuredOnly) list = list.filter((tpl) => tpl.featured);
    const term = search.trim().toLowerCase();
    if (term) {
      list = list.filter((tpl) => {
        const haystack = [
          tpl.label,
          tpl.description,
          tpl.descriptionEn,
          tpl.author,
          ...(tpl.tags || [])
        ].join(' ').toLowerCase();
        return haystack.includes(term);
      });
    }
    list.sort((a, b) => {
      if (sortKey === 'name') return a.label.localeCompare(b.label);
      if (sortKey === 'category') return a.category.localeCompare(b.category) || a.label.localeCompare(b.label);
      return Number(b.featured) - Number(a.featured) || a.label.localeCompare(b.label);
    });
    return list;
  }, [templates, category, featuredOnly, search, sortKey]);

  useEffect(() => {
    if (!visibleTemplates.length) return;
    if (!visibleTemplates.some((tpl) => tpl.id === selectedId)) {
      setSelectedId(visibleTemplates[0].id);
    }
  }, [visibleTemplates, selectedId]);

  const selectedTemplate = visibleTemplates.find((tpl) => tpl.id === selectedId) || templates.find((tpl) => tpl.id === selectedId) || templates[0] || null;
  const categoryOptions = categories.length ? categories : FALLBACK_CATEGORIES;

  const summary = useMemo(() => {
    const total = templates.length;
    const featured = templates.filter((tpl) => tpl.featured).length;
    return { total, featured };
  }, [templates]);

  const handleCreate = async (tpl: TemplateMeta) => {
    const name = createName.trim() || tpl.label;
    setCreatingId(tpl.id);
    try {
      const created = await createProject({ name, template: tpl.id });
      navigate(`/editor/${created.id}`);
    } catch (err) {
      setStatus(t('创建失败: {{error}}', { error: String(err) }));
    } finally {
      setCreatingId(null);
      setCreateOpen(false);
    }
  };

  return (
    <div className="template-library-page">
      <header className="template-library-hero">
        <div className="template-library-hero-copy">
          <div className="template-library-kicker">{t('模板库')}</div>
          <h1>{t('从计算机会议和期刊模板开始')}</h1>
          <p>
            {t('覆盖计算机会议和期刊模板，直接挑选模板、预览结构、创建项目。')}
          </p>
        </div>
        <div className="template-library-hero-stats">
          <div className="stat-card">
            <span>{t('模板总数')}</span>
            <strong>{summary.total}</strong>
          </div>
          <div className="stat-card">
            <span>{t('精选模板')}</span>
            <strong>{summary.featured}</strong>
          </div>
          <div className="stat-card">
            <span>{t('当前分类')}</span>
            <strong>{categoryOptions.find((item) => item.id === category)?.[i18n.language === 'en-US' ? 'labelEn' : 'label'] || t('全部')}</strong>
          </div>
        </div>
      </header>

      <div className="template-library-toolbar">
        <input
          className="input template-library-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('搜索模板...')}
        />
        <div className="template-library-switches">
          <button className={`chip-toggle${featuredOnly ? ' active' : ''}`} onClick={() => setFeaturedOnly((v) => !v)}>
            {t('精选模板')}
          </button>
          <button className={`chip-toggle${sortKey === 'featured' ? ' active' : ''}`} onClick={() => setSortKey('featured')}>
            {t('推荐')}
          </button>
          <button className={`chip-toggle${sortKey === 'name' ? ' active' : ''}`} onClick={() => setSortKey('name')}>
            {t('按名称')}
          </button>
          <button className={`chip-toggle${sortKey === 'category' ? ' active' : ''}`} onClick={() => setSortKey('category')}>
            {t('按分类')}
          </button>
        </div>
      </div>

      <div className="template-library-layout">
        <aside className="template-library-sidebar">
          <div className="template-library-panel">
            <div className="template-library-panel-title">{t('分类')}</div>
            <div className="template-category-list">
              {categoryOptions.map((item) => {
                const label = i18n.language === 'en-US' ? item.labelEn : item.label;
                return (
                  <button
                    key={item.id}
                    className={`template-category-item${category === item.id ? ' active' : ''}`}
                    onClick={() => setCategory(item.id)}
                  >
                    <span>{label}</span>
                    <span>{item.id === 'all' ? templates.length : templates.filter((tpl) => tpl.category === item.id).length}</span>
                  </button>
                );
              })}
            </div>
          </div>

        </aside>

        <section className="template-library-browser">
          <div className="template-library-panel-head">
            <div className="template-library-panel-title">{t('模板清单')}</div>
            <div className="template-library-panel-count">
              {visibleTemplates.length}/{templates.length}
            </div>
          </div>
          <div className="template-browser-grid">
            {visibleTemplates.map((tpl) => (
              <button
                key={tpl.id}
                className={`template-browser-card${selectedId === tpl.id ? ' active' : ''}`}
                onClick={() => setSelectedId(tpl.id)}
              >
                <span className="template-browser-thumb">
                  <span className="template-browser-thumb-head">{tpl.mainFile}</span>
                  <span className="template-browser-thumb-title">{tpl.label}</span>
                  <span className="template-browser-thumb-line" />
                  <span className="template-browser-thumb-line short" />
                  <span className="template-browser-thumb-tags">
                    {(tpl.tags || []).slice(0, 2).map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </span>
                </span>
                <span className="template-browser-card-body">
                  <span className="template-browser-card-meta">
                    {tpl.author || 'Official'} · {tpl.mainFile}
                  </span>
                  <span className="template-browser-card-title">{tpl.label}</span>
                  <span className="template-browser-card-desc">
                    {i18n.language === 'en-US' ? tpl.descriptionEn || tpl.description : tpl.description}
                  </span>
                </span>
              </button>
            ))}
            {!loading && visibleTemplates.length === 0 && (
              <div className="template-list-empty">{t('暂无匹配模板')}</div>
            )}
            {loading && (
              <div className="template-list-empty">{t('加载中...')}</div>
            )}
          </div>
        </section>

        <section className="template-library-detail">
          {selectedTemplate ? (
            <>
              <div className="template-detail-header">
                <div>
                  <div className="template-detail-title-row">
                    <h2>{selectedTemplate.label}</h2>
                    {selectedTemplate.featured && <span className="template-badge">{t('精选')}</span>}
                  </div>
                  <p>
                    {i18n.language === 'en-US'
                      ? selectedTemplate.descriptionEn || selectedTemplate.description
                      : selectedTemplate.description}
                  </p>
                </div>
                <div className="template-detail-actions">
                  <button
                    className="btn"
                    disabled={creatingId === selectedTemplate.id}
                    onClick={() => {
                      setCreateName('');
                      setCreateOpen(true);
                    }}
                  >
                    {creatingId === selectedTemplate.id ? t('创建中...') : t('使用此模板')}
                  </button>
                  <button className="btn ghost" onClick={() => navigate('/projects')}>{t('返回项目')}</button>
                </div>
              </div>

              <div className="template-preview-shell">
                <div className={`template-preview template-preview--${selectedTemplate.id}`}>
                  <div className="template-preview-top">
                    <span>{selectedTemplate.mainFile}</span>
                    <span>{categoryOptions.find((item) => item.id === selectedTemplate.category)?.[i18n.language === 'en-US' ? 'labelEn' : 'label'] || selectedTemplate.category}</span>
                  </div>
                  <div className="template-preview-body">
                    <div className="template-preview-heading">{selectedTemplate.label}</div>
                    <div className="template-preview-lines">
                      <span />
                      <span />
                      <span />
                      <span />
                    </div>
                    <div className="template-preview-chip-row">
                      {(HIGHLIGHTS[selectedTemplate.id] || selectedTemplate.tags || []).slice(0, 4).map((tag) => (
                        <span key={tag} className="template-preview-chip">{tag}</span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="template-meta-grid">
                  <div className="template-meta-card">
                    <span>{t('主文件')}</span>
                    <strong>{selectedTemplate.mainFile}</strong>
                  </div>
                  <div className="template-meta-card">
                    <span>{t('作者')}</span>
                    <strong>{selectedTemplate.author || 'OpenPrism'}</strong>
                  </div>
                  <div className="template-meta-card">
                    <span>{t('标签')}</span>
                    <strong>{(selectedTemplate.tags || []).join(' / ') || '—'}</strong>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="template-list-empty">{loading ? t('加载中...') : t('暂无匹配模板')}</div>
          )}
        </section>
      </div>

      <div className="template-library-note">
        {status || t('模板来自项目内置清单，可直接创建新项目。')}
      </div>

      {createOpen && selectedTemplate && (
        <div className="modal-backdrop" onClick={() => setCreateOpen(false)}>
          <div className="modal template-create-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>{t('新建项目')}</div>
              <button className="icon-btn" onClick={() => setCreateOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>{t('项目名称')}</label>
                <input
                  className="input"
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  placeholder={selectedTemplate.label}
                />
              </div>
              <div className="template-create-summary">
                <strong>{selectedTemplate.label}</strong>
                <span>{selectedTemplate.mainFile}</span>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setCreateOpen(false)}>{t('取消')}</button>
              <button className="btn" onClick={() => handleCreate(selectedTemplate)}>{t('使用此模板')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
