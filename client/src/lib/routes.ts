/**
 * Every page a user can navigate to, in one list. The Sidebar, the command
 * palette, the Header title, breadcrumbs and the Cmd+N shortcut all read it,
 * so a new page is added here once.
 */

export type RouteSection = 'main' | 'admin' | 'account';

export interface AppRoute {
  href: string;
  /** Sidebar and breadcrumb label. */
  label: string;
  /** Header title, when it differs from the label. */
  title?: string;
  /** Command-palette description. */
  description: string;
  section: RouteSection;
  /** Shown in the Sidebar. Off for pages reached from elsewhere. */
  nav?: boolean;
  /** Sidebar badge the Sidebar knows how to fill. */
  badge?: 'unreadAlerts';
  /** SVG path data (24x24 outline icon), one entry per <path>. */
  icon?: string[];
}

export const NEW_JOB_HREF = '/jobs/create';

export const ROUTES: AppRoute[] = [
  {
    href: '/', label: 'Dashboard', description: 'Main dashboard', section: 'main', nav: true,
    icon: ['M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1'],
  },
  {
    href: NEW_JOB_HREF, label: 'New Job', description: 'Create a new scraping job', section: 'main', nav: true,
    icon: ['M12 4v16m8-8H4'],
  },
  {
    href: '/jobs/history', label: 'History', title: 'Job History', description: 'Browse all past jobs', section: 'main', nav: true,
    icon: ['M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z'],
  },
  {
    href: '/analytics', label: 'Analytics', description: 'Scraping analytics', section: 'main', nav: true,
    icon: ['M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z'],
  },
  {
    href: '/alerts', label: 'Alerts', description: 'Price, stock and image alerts', section: 'main', nav: true, badge: 'unreadAlerts',
    icon: ['M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0'],
  },
  {
    href: '/admin/users', label: 'Users', title: 'User Management', description: 'Manage user accounts', section: 'admin', nav: true,
    icon: ['M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z'],
  },
  {
    href: '/admin/audit-logs', label: 'Audit Logs', description: 'View audit trail', section: 'admin', nav: true,
    icon: ['M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'],
  },
  {
    href: '/admin/messages', label: 'Messages', description: 'Global message management', section: 'admin', nav: true,
    icon: ['M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z'],
  },
  {
    href: '/admin/analytics', label: 'Admin Analytics', description: 'Admin analytics dashboard', section: 'admin', nav: true,
    icon: ['M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z'],
  },
  {
    href: '/admin/dlq', label: 'Failed Jobs', description: 'Retry or discard jobs that ran out of attempts', section: 'admin', nav: true,
    icon: ['M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z'],
  },
  {
    href: '/config', label: 'Config', title: 'Configuration', description: 'Sites, brands, scraping provider, SSO, email and appearance', section: 'admin', nav: true,
    icon: [
      'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
      'M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    ],
  },
  {
    href: '/admin/site-monitor', label: 'Site Monitor', description: 'Site change monitoring', section: 'admin', nav: true,
    icon: ['M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z'],
  },
  {
    href: '/admin/health', label: 'System Health', description: 'Live service health and maintenance actions', section: 'admin', nav: true,
    icon: ['M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z'],
  },
  { href: '/config?tab=email', label: 'Email Settings', description: 'Configure the SMTP email provider', section: 'admin' },
  { href: '/sites/new', label: 'Add Retailer', description: 'Preview and add a retailer site', section: 'admin' },
  { href: '/account', label: 'Account', description: 'Account settings', section: 'account' },
  { href: '/change-password', label: 'Change Password', description: 'Update your password', section: 'account' },
];

const byPath = new Map(ROUTES.filter((r) => !r.href.includes('?')).map((r) => [r.href, r]));

/** Header title for a pathname, including the dynamic pages. */
export function pageTitle(pathname: string): string {
  const route = byPath.get(pathname);
  if (route) return route.title ?? route.label;
  if (pathname.startsWith('/jobs/')) return 'Job Details';
  if (pathname.startsWith('/admin/email-settings/templates/')) return 'Email Template';
  return '';
}

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Breadcrumbs for the page at `href`: Dashboard, then Admin for admin pages,
 * then the route itself. `tail` adds crumbs below it (a job id, a template),
 * in which case the route crumb links back to its page.
 */
export function crumbs(href: string, ...tail: Crumb[]): Crumb[] {
  const route = byPath.get(href);
  if (!route) throw new Error(`crumbs(): ${href} is not in ROUTES`);
  return [
    { label: 'Dashboard', href: '/' },
    ...(route.section === 'admin' ? [{ label: 'Admin' }] : []),
    tail.length ? { label: route.label, href } : { label: route.label },
    ...tail,
  ];
}
