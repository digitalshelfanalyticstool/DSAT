import { redirect } from 'next/navigation';

// Email Settings moved into Config → Sidebar entry removed. Old URL (and the
// template-editor breadcrumb at /admin/email-settings/templates/[slug]) redirect
// to the Config tab so bookmarks and command-palette links keep working.
export default function EmailSettingsPage() {
  redirect('/config?tab=email');
}
