'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { MainLayout } from '@/components/layout/MainLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { apiClient } from '@/lib/api-client';
import type { SiteInput } from '@/lib/api-client';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { useConfig } from '@/providers/ConfigProvider';
import { EmailSettingsPanel } from '@/app/admin/email-settings/EmailSettingsPanel';
import { ScrapingProviderPanel } from './ScrapingProviderPanel';
import { SingleSignOnPanel } from './SingleSignOnPanel';
import { AppearancePanel } from './AppearancePanel';


interface Site {
  site_id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  brand_urls?: Record<string, string>;
  adapter?: string;
  listing_url_template?: string;
  product_link_pattern?: string;
}

const EMPTY_SITE_FORM = {
  name: '', base_url: '', brand_urls: '',
  adapter: '', listing_url_template: '', product_link_pattern: '',
};

interface Brand {
  brand_id: string;
  name: string;
  filter_criteria: Record<string, unknown>;
  enabled: boolean;
  allowed_retailers?: string[];
}

type Tab = 'sites' | 'brands' | 'scraping' | 'sso' | 'email' | 'appearance';

const VALID_TABS: Tab[] = ['sites', 'brands', 'scraping', 'sso', 'email', 'appearance'];

// Seed the active tab from ?tab= so deep links (command palette, redirected
// /admin/email-settings URL) open the right tab.
function resolveTab(param: string | null): Tab {
  if (param === 'credentials') return 'scraping'; // pre-rename deep links
  return VALID_TABS.includes(param as Tab) ? (param as Tab) : 'sites';
}

function ConfigPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { authChecked } = useRequireAuth({ role: 'admin' });
  const { refresh: refreshConfig } = useConfig();
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>(resolveTab(searchParams.get('tab')));

  // Sites state
  const [sites, setSites] = useState<Site[]>([]);
  const [showSiteForm, setShowSiteForm] = useState(false);
  const [editingSite, setEditingSite] = useState<Site | null>(null);
  const [siteForm, setSiteForm] = useState(EMPTY_SITE_FORM);
  const [siteError, setSiteError] = useState('');
  // The server names the adapters, its default, and which need a link pattern.
  const [adapters, setAdapters] = useState<string[]>([]);
  const [defaultAdapter, setDefaultAdapter] = useState('');
  const [patternAdapters, setPatternAdapters] = useState<string[]>([]);
  // Per-action loading flags so we can disable the
  // specific button that triggered the call. Save spans the entire form;
  // togglingSites is keyed by site_id so we don't disable every toggle on
  // every row when only one is in flight.
  const [siteSaving, setSiteSaving] = useState(false);
  const [togglingSites, setTogglingSites] = useState<Set<string>>(new Set());

  // Brands state
  const [brands, setBrands] = useState<Brand[]>([]);
  const [showBrandForm, setShowBrandForm] = useState(false);
  const [editingBrand, setEditingBrand] = useState<Brand | null>(null);
  const [brandForm, setBrandForm] = useState({ name: '', filter_criteria: '', allowed_retailers: '' });
  const [brandError, setBrandError] = useState('');

  const siteButtonLabel = editingSite ? 'Update Site' : 'Add Site';

  useEffect(() => {
    if (!authChecked) return;
    loadData().finally(() => setLoading(false));
  }, [authChecked]);

  // Keep the active tab in sync with ?tab= across client-side navigation between
  // /config?tab=… URLs (command palette, the redirected /admin/email-settings
  // link). The useState initializer only runs on mount, so
  // without this the tab strip would ignore query changes on an already-mounted page.
  useEffect(() => {
    setActiveTab(resolveTab(searchParams.get('tab')));
  }, [searchParams]);

  const loadData = async () => {
    try {
      // This admin page mutates sites/brands and must re-fetch fresh rows after
      // each mutation; ConfigProvider's 5-min cache would show stale ones.
      // afterMutation() refreshes that cache too, for the rest of the app.
      const [sitesRes, brandsRes, adaptersRes] = await Promise.all([
        // eslint-disable-next-line no-restricted-syntax -- fresh rows after a mutation, see above.
        apiClient.getSites(),
        // eslint-disable-next-line no-restricted-syntax -- fresh rows after a mutation, see above.
        apiClient.getBrands(),
        apiClient.getAdapters().catch(() => null),
      ]);
      setSites(sitesRes.sites);
      if (adaptersRes) {
        setAdapters(adaptersRes.adapters);
        setDefaultAdapter(adaptersRes.default_adapter ?? '');
        setPatternAdapters(adaptersRes.needs_link_pattern ?? []);
      }
      setBrands(brandsRes.brands);
    } catch (err: unknown) {
      console.error('Failed to load configuration data:', err instanceof Error ? err.message : String(err));
    }
  };

  const afterMutation = async () => {
    await Promise.all([loadData(), refreshConfig()]);
  };

  // Site handlers
  const handleAddSite = () => {
    setSiteForm({ ...EMPTY_SITE_FORM, adapter: defaultAdapter });
    setEditingSite(null);
    setSiteError('');
    setShowSiteForm(true);
  };

  const handleEditSite = (site: Site) => {
    setSiteForm({
      name: site.name,
      base_url: site.base_url,
      brand_urls: site.brand_urls ? JSON.stringify(site.brand_urls, null, 2) : '',
      adapter: site.adapter || defaultAdapter,
      listing_url_template: site.listing_url_template ?? '',
      product_link_pattern: site.product_link_pattern ?? '',
    });
    setEditingSite(site);
    setSiteError('');
    setShowSiteForm(true);
  };

  const handleSaveSite = async () => {
    setSiteError('');

    if (!siteForm.name || !siteForm.base_url) {
      setSiteError('Site name and base URL are required');
      return;
    }

    setSiteSaving(true);
    try {
      const payload: SiteInput = {
        name: siteForm.name,
        base_url: siteForm.base_url,
        // Unset when the adapter list failed to load; the server applies its default.
        ...(siteForm.adapter && { adapter: siteForm.adapter }),
        listing_url_template: siteForm.listing_url_template,
        product_link_pattern: siteForm.product_link_pattern,
      };
      if (siteForm.brand_urls.trim()) {
        payload.brand_urls = JSON.parse(siteForm.brand_urls);
      }
      if (editingSite) {
        await apiClient.updateSite(editingSite.site_id, payload);
      } else {
        await apiClient.addSite(payload);
      }
      await afterMutation();
      setShowSiteForm(false);
      setSiteForm(EMPTY_SITE_FORM);
      setEditingSite(null);
    } catch (err: unknown) {
      setSiteError(err instanceof Error ? err.message : 'Failed to save site. Check Brand URLs JSON.');
    } finally {
      setSiteSaving(false);
    }
  };

  const handleToggleSite = async (site: Site) => {
    // Track this site_id while the toggle request is in flight so the row's
    // Enable/Disable button is disabled — prevents double-clicks that would
    // toggle to the wrong state if the second request lands first.
    setTogglingSites((prev) => {
      const next = new Set(prev);
      next.add(site.site_id);
      return next;
    });
    try {
      await apiClient.updateSite(site.site_id, { enabled: !site.enabled });
      await afterMutation();
    } catch (err: unknown) {
      console.error('Failed to toggle site:', err instanceof Error ? err.message : String(err));
    } finally {
      setTogglingSites((prev) => {
        const next = new Set(prev);
        next.delete(site.site_id);
        return next;
      });
    }
  };

  // Brand handlers
  const handleAddBrand = () => {
    setBrandForm({ name: '', filter_criteria: '', allowed_retailers: '' });
    setEditingBrand(null);
    setBrandError('');
    setShowBrandForm(true);
  };

  const handleEditBrand = (brand: Brand) => {
    setBrandForm({
      name: brand.name,
      filter_criteria: JSON.stringify(brand.filter_criteria, null, 2),
      allowed_retailers: brand.allowed_retailers ? JSON.stringify(brand.allowed_retailers, null, 2) : '',
    });
    setEditingBrand(brand);
    setBrandError('');
    setShowBrandForm(true);
  };

  const handleSaveBrand = async () => {
    setBrandError('');
    
    if (!brandForm.name || !brandForm.filter_criteria) {
      setBrandError('All fields are required');
      return;
    }

    try {
      const filterCriteria = JSON.parse(brandForm.filter_criteria);
      const allowedRetailers = brandForm.allowed_retailers.trim()
        ? (JSON.parse(brandForm.allowed_retailers) as string[])
        : undefined;

      if (editingBrand) {
        await apiClient.updateBrand(editingBrand.brand_id, {
          name: brandForm.name,
          filter_criteria: filterCriteria,
          ...(allowedRetailers && { allowed_retailers: allowedRetailers }),
        });
      } else {
        await apiClient.addBrand({
          name: brandForm.name,
          filter_criteria: filterCriteria,
          ...(allowedRetailers && { allowed_retailers: allowedRetailers }),
        });
      }
      await afterMutation();
      setShowBrandForm(false);
      setBrandForm({ name: '', filter_criteria: '', allowed_retailers: '' });
      setEditingBrand(null);
    } catch (err: unknown) {
      setBrandError(err instanceof Error ? err.message : 'Failed to save brand. Check JSON format.');
    }
  };

  const handleToggleBrand = async (brand: Brand) => {
    try {
      await apiClient.updateBrand(brand.brand_id, { enabled: !brand.enabled });
      await afterMutation();
    } catch (err: unknown) {
      console.error('Failed to toggle brand:', err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center py-24">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent" />
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-ink">Configuration Management</h1>
          <p className="mt-1 text-ink-muted">Manage sites, brands, the scraping provider, single sign-on, and email</p>
        </div>

        {/* Tabs */}
        <div className="border-b border-hairline">
          <nav className="-mb-px flex space-x-8">
            <button
              onClick={() => setActiveTab('sites')}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
                activeTab === 'sites'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-ink-muted hover:text-ink hover:border-hairline'
              }`}
            >
              Sites
            </button>
            <button
              onClick={() => setActiveTab('brands')}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
                activeTab === 'brands'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-ink-muted hover:text-ink hover:border-hairline'
              }`}
            >
              Brands
            </button>
            <button
              onClick={() => setActiveTab('scraping')}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
                activeTab === 'scraping'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-ink-muted hover:text-ink hover:border-hairline'
              }`}
            >
              Scraping provider
            </button>
            <button
              onClick={() => setActiveTab('sso')}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
                activeTab === 'sso'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-ink-muted hover:text-ink hover:border-hairline'
              }`}
            >
              Single sign-on
            </button>
            <button
              onClick={() => setActiveTab('email')}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
                activeTab === 'email'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-ink-muted hover:text-ink hover:border-hairline'
              }`}
            >
              Email
            </button>
            <button
              onClick={() => setActiveTab('appearance')}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
                activeTab === 'appearance'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-ink-muted hover:text-ink hover:border-hairline'
              }`}
            >
              Appearance
            </button>
          </nav>
        </div>

        {/* Sites Tab */}
        {activeTab === 'sites' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold text-ink">Site Configurations</h2>
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => router.push('/sites/new')}>
                  Add a retailer
                </Button>
                <Button variant="outline" onClick={handleAddSite}>
                  Add Site
                </Button>
              </div>
            </div>

            {showSiteForm && (
              <Card title={editingSite ? 'Edit Site' : 'Add New Site'}>
                <div className="space-y-4">
                  {siteError && (
                    <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 rounded">
                      {siteError}
                    </div>
                  )}
                  <Input
                    label="Site Name"
                    value={siteForm.name}
                    onChange={(e) => setSiteForm({ ...siteForm, name: e.target.value })}
                    placeholder="e.g., exampleshop"
                  />
                  <Input
                    label="Base URL"
                    value={siteForm.base_url}
                    onChange={(e) => setSiteForm({ ...siteForm, base_url: e.target.value })}
                    placeholder="e.g., https://shop.example.com"
                  />
                  <Select
                    label="Adapter"
                    value={siteForm.adapter}
                    onChange={(e) => setSiteForm({ ...siteForm, adapter: e.target.value })}
                    options={adapters.map((id) => ({ value: id, label: id }))}
                  />
                  <div>
                    <Input
                      label="Product link pattern"
                      value={siteForm.product_link_pattern}
                      onChange={(e) => setSiteForm({ ...siteForm, product_link_pattern: e.target.value })}
                      placeholder="e.g., /p/[^/?#]+/\d+"
                    />
                    <p className="text-xs text-ink-muted mt-1">
                      Regex matched against each link&apos;s path on a listing page.
                      {patternAdapters.includes(siteForm.adapter || defaultAdapter)
                        ? ' Required by this adapter.'
                        : ' Not used by this adapter.'}
                    </p>
                  </div>
                  <div>
                    <Input
                      label="Listing URL template"
                      value={siteForm.listing_url_template}
                      onChange={(e) => setSiteForm({ ...siteForm, listing_url_template: e.target.value })}
                      placeholder="e.g., https://shop.example.com/brand/{brand}?page={page}"
                    />
                    <p className="text-xs text-ink-muted mt-1">
                      Optional. Used for brands with no Brand URLs entry. See docs/ADAPTERS.md.
                    </p>
                  </div>
                  <div>
                    <label htmlFor="site-brand-urls" className="block text-sm font-medium text-ink mb-1">
                      Brand URLs (JSON)
                    </label>
                    <textarea
                      id="site-brand-urls"
                      value={siteForm.brand_urls}
                      onChange={(e) => setSiteForm({ ...siteForm, brand_urls: e.target.value })}
                      placeholder={'{"example brand": "https://shop.example.com/brands/example-brand"}'}
                      rows={5}
                      className="w-full px-3 py-2 border border-hairline rounded-md focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent font-mono text-sm"
                    />
                    <p className="text-xs text-ink-muted mt-1">
                      Per-brand discovery URLs (key = brand name lowercase). Blank = none.
                    </p>
                  </div>
                  <div className="flex space-x-3">
                    <Button variant="primary" onClick={handleSaveSite} disabled={siteSaving}>
                      {siteSaving ? 'Saving...' : siteButtonLabel}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setShowSiteForm(false);
                        setSiteForm(EMPTY_SITE_FORM);
                        setEditingSite(null);
                        setSiteError('');
                      }}
                      disabled={siteSaving}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              </Card>
            )}

            <Card>
              <div className="space-y-4">
                {sites.length === 0 ? (
                  <p className="text-center text-ink-muted py-8">
                    No sites yet. Add a site to start tracking a retailer — see docs/ADAPTERS.md.
                  </p>
                ) : (
                  sites.map((site) => {
                    const isToggling = togglingSites.has(site.site_id);
                    const toggleButtonLabel = site.enabled ? 'Disable' : 'Enable';
                    return (
                      <div
                        key={site.site_id}
                        className="flex items-center justify-between p-4 bg-surface-tertiary rounded-lg"
                      >
                        <div className="flex-1">
                          <div className="flex items-center space-x-3">
                            <h3 className="font-medium text-ink">{site.name}</h3>
                            <Badge variant={site.enabled ? 'success' : 'default'}>
                              {site.enabled ? 'Enabled' : 'Disabled'}
                            </Badge>
                          </div>
                          <p className="text-sm text-ink-muted mt-1">URL: {site.base_url}</p>
                          <p className="text-sm text-ink-muted">Adapter: {site.adapter || defaultAdapter || 'default'}</p>
                        </div>
                        <div className="flex space-x-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleEditSite(site)}
                            disabled={isToggling}
                          >
                            Edit
                          </Button>
                          <Button
                            variant={site.enabled ? 'outline' : 'primary'}
                            size="sm"
                            onClick={() => handleToggleSite(site)}
                            disabled={isToggling}
                          >
                            {/* Per-site toggling flag prevents double-clicks racing
                                each other to the wrong terminal state. */}
                            {isToggling ? '...' : toggleButtonLabel}
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </Card>
          </div>
        )}

        {/* Brands Tab */}
        {activeTab === 'brands' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold text-ink">Brand Configurations</h2>
              <Button variant="primary" onClick={handleAddBrand}>
                Add Brand
              </Button>
            </div>

            {showBrandForm && (
              <Card title={editingBrand ? 'Edit Brand' : 'Add New Brand'}>
                <div className="space-y-4">
                  {brandError && (
                    <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 rounded">
                      {brandError}
                    </div>
                  )}
                  <Input
                    label="Brand Name"
                    value={brandForm.name}
                    onChange={(e) => setBrandForm({ ...brandForm, name: e.target.value })}
                    placeholder="e.g., Example Brand"
                  />
                  <div>
                    <label htmlFor="brand-filter-criteria" className="block text-sm font-medium text-ink mb-1">
                      Filter Criteria (JSON)
                    </label>
                    <textarea
                      id="brand-filter-criteria"
                      value={brandForm.filter_criteria}
                      onChange={(e) => setBrandForm({ ...brandForm, filter_criteria: e.target.value })}
                      placeholder='{"brand": "Example Brand"}'
                      rows={6}
                      className="w-full px-3 py-2 border border-hairline rounded-md focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent font-mono text-sm"
                    />
                    <p className="text-xs text-ink-muted mt-1">
                      Enter filter criteria as valid JSON
                    </p>
                  </div>
                  <div>
                    <label htmlFor="brand-allowed-retailers" className="block text-sm font-medium text-ink mb-1">
                      Allowed Retailers (JSON)
                    </label>
                    <textarea
                      id="brand-allowed-retailers"
                      value={brandForm.allowed_retailers}
                      onChange={(e) => setBrandForm({ ...brandForm, allowed_retailers: e.target.value })}
                      placeholder={'["exampleshop"]'}
                      rows={3}
                      className="w-full px-3 py-2 border border-hairline rounded-md focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent font-mono text-sm"
                    />
                    <p className="text-xs text-ink-muted mt-1">
                      Retailers this brand may run on (JSON array of site names). Blank = all retailers.
                    </p>
                  </div>
                  <div className="flex space-x-3">
                    <Button variant="primary" onClick={handleSaveBrand}>
                      {editingBrand ? 'Update Brand' : 'Add Brand'}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setShowBrandForm(false);
                        setBrandForm({ name: '', filter_criteria: '', allowed_retailers: '' });
                        setEditingBrand(null);
                        setBrandError('');
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              </Card>
            )}

            <Card>
              <div className="space-y-4">
                {brands.length === 0 ? (
                  <p className="text-center text-ink-muted py-8">No brands configured yet.</p>
                ) : (
                  brands.map((brand) => (
                    <div
                      key={brand.brand_id}
                      className="flex items-center justify-between p-4 bg-surface-tertiary rounded-lg"
                    >
                      <div className="flex-1">
                        <div className="flex items-center space-x-3">
                          <h3 className="font-medium text-ink">{brand.name}</h3>
                          <Badge variant={brand.enabled ? 'success' : 'default'}>
                            {brand.enabled ? 'Enabled' : 'Disabled'}
                          </Badge>
                        </div>
                        <p className="text-sm text-ink-muted mt-1 font-mono">
                          {JSON.stringify(brand.filter_criteria)}
                        </p>
                      </div>
                      <div className="flex space-x-2">
                        <Button variant="outline" size="sm" onClick={() => handleEditBrand(brand)}>
                          Edit
                        </Button>
                        <Button
                          variant={brand.enabled ? 'outline' : 'primary'}
                          size="sm"
                          onClick={() => handleToggleBrand(brand)}
                        >
                          {brand.enabled ? 'Disable' : 'Enable'}
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>
        )}

        {/* Scraping provider Tab */}
        {activeTab === 'scraping' && <ScrapingProviderPanel />}
        {activeTab === 'sso' && <SingleSignOnPanel />}
        {activeTab === 'appearance' && <AppearancePanel />}

        {/* Email Tab */}
        {activeTab === 'email' && <EmailSettingsPanel />}
      </div>
    </MainLayout>
  );
}

export default function ConfigPage() {
  return (
    <Suspense
      fallback={
        <MainLayout>
          <div className="flex items-center justify-center py-24">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent" />
          </div>
        </MainLayout>
      }
    >
      <ConfigPageInner />
    </Suspense>
  );
}
