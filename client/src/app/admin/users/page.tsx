'use client';

import React, { useState, useEffect, useCallback, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { MainLayout } from '@/components/layout/MainLayout';
import { Card, Button, Badge, Select, Input, Pagination, Modal } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { apiClient } from '@/lib/api-client';
import type { AdminUser } from '@/lib/api-client';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { formatDate } from '@/lib/format';
import { crumbs } from '@/lib/routes';

type SortField = 'username' | 'email' | 'role' | 'created_at';
type SortDir = 'asc' | 'desc';

interface UserFormData {
  username: string;
  email: string;
  password: string;
  role: string;
}

const EMPTY_FORM: UserFormData = { username: '', email: '', password: '', role: 'user' };
const PAGE_SIZE = 20;
// SonarJS flags this regex as potentially super-linear, but negated character
// classes have no overlap and cannot backtrack catastrophically. False positive.
// eslint-disable-next-line sonarjs/super-linear-regex -- safe negated class; see comment above.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function AdminUsersPageInner() {
  const { authChecked } = useRequireAuth({ role: 'admin' });
  const { showToast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Data state
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters — seeded from URL params
  const [roleFilter, setRoleFilter] = useState(() => searchParams.get('role') ?? '');
  const [activeFilter, setActiveFilter] = useState(() => searchParams.get('status') ?? '');
  const [searchFilter, setSearchFilter] = useState(() => searchParams.get('q') ?? '');

  // Sorting
  const [sortField, setSortField] = useState<SortField>('created_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Pagination (client-side since API returns all)
  const [currentPage, setCurrentPage] = useState(() => {
    const p = Number(searchParams.get('page'));
    return Number.isFinite(p) && p > 0 ? p : 1;
  });

  // Sync URL params when filters or page change
  useEffect(() => {
    const params = new URLSearchParams();
    if (roleFilter) params.set('role', roleFilter);
    if (activeFilter) params.set('status', activeFilter);
    if (searchFilter) params.set('q', searchFilter);
    if (currentPage > 1) params.set('page', String(currentPage));
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : '?', { scroll: false });
  }, [roleFilter, activeFilter, searchFilter, currentPage, router]);

  // Modals
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [resetPwOpen, setResetPwOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);

  // Bulk selection
  const [selectedUserIds, setSelectedUserIds] = useState<Set<number>>(new Set());

  // Import modal
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ created: number; updated: number; errors: Array<{ row: number; error: string }> } | null>(null);

  // Form state
  const [formData, setFormData] = useState<UserFormData>(EMPTY_FORM);
  const [newPassword, setNewPassword] = useState('');
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Load users
  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const filters: Record<string, string> = {};
      if (roleFilter) filters.role = roleFilter;
      // "locked" is a client-side filter; fetch inactive users then filter
      if (activeFilter && activeFilter !== 'locked') filters.is_active = activeFilter;
      if (activeFilter === 'locked') filters.is_active = 'false';
      if (searchFilter) filters.search = searchFilter;
      const res = await apiClient.getAdminUsers(filters);
      if (activeFilter === 'locked') {
        setUsers(res.users.filter((u: AdminUser) => u.locked_until != null));
      } else {
        setUsers(res.users);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load users', 'error');
    } finally {
      setLoading(false);
    }
  }, [roleFilter, activeFilter, searchFilter, showToast]);

  useEffect(() => {
    if (authChecked) {
      setSelectedUserIds(new Set());
      loadUsers();
    }
  }, [authChecked, loadUsers]);

  // Sorting
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
    setCurrentPage(1);
  };

  const sortedUsers = useMemo(
    () =>
      [...users].sort((a, b) => {
        const dir = sortDir === 'asc' ? 1 : -1;
        const aVal = a[sortField];
        const bVal = b[sortField];
        if (typeof aVal === 'string' && typeof bVal === 'string') {
          return aVal.localeCompare(bVal) * dir;
        }
        return 0;
      }),
    [users, sortField, sortDir],
  );

  const totalPages = Math.max(1, Math.ceil(sortedUsers.length / PAGE_SIZE));
  const pagedUsers = sortedUsers.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Validation
  const validateForm = (data: UserFormData, requirePassword: boolean): Record<string, string> => {
    const errors: Record<string, string> = {};
    if (!data.username || data.username.length < 3 || data.username.length > 50) {
      errors.username = 'Username must be 3-50 characters';
    }
    if (!data.email || !EMAIL_PATTERN.test(data.email)) {
      errors.email = 'Valid email is required';
    }
    if (requirePassword && (!data.password || data.password.length < 8)) {
      errors.password = 'Password must be at least 8 characters';
    }
    return errors;
  };

  // Create user
  const handleCreate = async () => {
    const errors = validateForm(formData, true);
    if (Object.keys(errors).length > 0) { setFormErrors(errors); return; }
    setSubmitting(true);
    try {
      await apiClient.createAdminUser({
        username: formData.username,
        email: formData.email,
        password: formData.password,
        role: formData.role,
      });
      showToast('User created', 'success');
      setCreateOpen(false);
      setFormData(EMPTY_FORM);
      setFormErrors({});
      await loadUsers();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to create user', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // Edit user
  const openEdit = (u: AdminUser) => {
    setSelectedUser(u);
    setFormData({ username: u.username, email: u.email, password: '', role: u.role });
    setFormErrors({});
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!selectedUser) return;
    const errors = validateForm(formData, false);
    if (formData.password && formData.password.length < 8) {
      errors.password = 'Password must be at least 8 characters';
    }
    if (Object.keys(errors).length > 0) { setFormErrors(errors); return; }
    setSubmitting(true);
    try {
      const updates: Record<string, unknown> = {
        username: formData.username,
        email: formData.email,
        role: formData.role,
      };
      if (formData.password) updates.password = formData.password;
      await apiClient.updateAdminUser(selectedUser.id, updates);
      showToast('User updated', 'success');
      setEditOpen(false);
      setFormErrors({});
      await loadUsers();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update user', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // Delete user
  const openDelete = (u: AdminUser) => { setSelectedUser(u); setDeleteOpen(true); };

  const handleDelete = async () => {
    if (!selectedUser) return;
    setSubmitting(true);
    try {
      await apiClient.deleteAdminUser(selectedUser.id);
      showToast('User deactivated', 'success');
      setDeleteOpen(false);
      await loadUsers();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete user', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // Reactivate user
  const handleReactivate = async (u: AdminUser) => {
    try {
      await apiClient.reactivateAdminUser(u.id);
      showToast('User reactivated', 'success');
      await loadUsers();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to reactivate user', 'error');
    }
  };

  const handleUnlock = async (u: AdminUser) => {
    try {
      await apiClient.unlockAdminUser(u.id);
      showToast('Account unlocked', 'success');
      await loadUsers();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to unlock user', 'error');
    }
  };

  const handleLock = async (u: AdminUser) => {
    try {
      await apiClient.lockAdminUser(u.id);
      showToast('Account locked', 'success');
      await loadUsers();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to lock user', 'error');
    }
  };

  // Bulk deactivate
  const handleBulkDeactivate = async () => {
    const ids = Array.from(selectedUserIds);
    const results = await Promise.allSettled(ids.map((id) => apiClient.deleteAdminUser(id)));
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    showToast(
      failed === 0 ? `${succeeded} user(s) deactivated` : `${succeeded} deactivated, ${failed} failed`,
      failed === 0 ? 'success' : 'error',
    );
    setSelectedUserIds(new Set());
    await loadUsers();
  };

  // Reset password
  const openResetPw = (u: AdminUser) => {
    setSelectedUser(u);
    setNewPassword('');
    setFormErrors({});
    setResetPwOpen(true);
  };

  const handleResetPassword = async () => {
    if (!selectedUser) return;
    if (!newPassword || newPassword.length < 8) {
      setFormErrors({ password: 'Password must be at least 8 characters' });
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.updateAdminUser(selectedUser.id, { password: newPassword });
      showToast('Password reset', 'success');
      setResetPwOpen(false);
      setNewPassword('');
      setFormErrors({});
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to reset password', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const SortHeader: React.FC<{ field: SortField; label: string }> = ({ field, label }) => (
    <th
      className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider cursor-pointer select-none hover:text-ink hover:bg-surface-tertiary/60 transition-colors"
      onClick={() => handleSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortField === field ? (
          <span className="text-accent">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>
        ) : (
          <span className="text-ink-muted">{'\u25BC'}</span>
        )}
      </span>
    </th>
  );

  const isActive = (u: AdminUser) => u.is_active === true || u.is_active === 1;
  const isLocked = (u: AdminUser) => !isActive(u) && u.locked_until != null;

  const lockedUsers = users.filter(isLocked);

  const userStatus = (u: AdminUser): { variant: 'success' | 'warning' | 'error'; label: string } => {
    if (isActive(u)) return { variant: 'success', label: 'Active' };
    if (isLocked(u)) return { variant: 'warning', label: 'Locked' };
    return { variant: 'error', label: 'Inactive' };
  };

  if (!authChecked) {
    return (
      <div className="min-h-dvh bg-surface-secondary/50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent mx-auto" />
      </div>
    );
  }

  const isEmptyUsers = pagedUsers.length === 0;

  return (
    <MainLayout>
      <Breadcrumbs
        items={crumbs('/admin/users')}
      />
      <div className="space-y-6">
        <div className="animate-in flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl font-bold text-ink">User Management</h1>
            <p className="mt-1 text-sm text-ink-muted">{users.length} total user{users.length === 1 ? '' : 's'}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={async () => {
              try { await apiClient.downloadExport('/admin/users/export?format=xlsx', 'users.xlsx'); }
              catch (err) { showToast(err instanceof Error ? err.message : 'Export failed', 'error'); }
            }}>
              Export XLSX
            </Button>
            <Button variant="outline" size="sm" onClick={async () => {
              try { await apiClient.downloadExport('/admin/users/export?format=csv', 'users.csv'); }
              catch (err) { showToast(err instanceof Error ? err.message : 'Export failed', 'error'); }
            }}>
              Export CSV
            </Button>
            <Button variant="outline" size="sm" onClick={() => { setImportFile(null); setImportResult(null); setImportOpen(true); }}>
              Import Users
            </Button>
            <Button variant="primary" onClick={() => { setFormData(EMPTY_FORM); setFormErrors({}); setCreateOpen(true); }}>
              <span className="inline-flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                Create User
              </span>
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="animate-in-delay relative z-10" style={{ '--stagger': 1 } as React.CSSProperties}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Select
              label="Role"
              value={roleFilter}
              onChange={(e) => { setRoleFilter(e.target.value); setCurrentPage(1); }}
              options={[
                { value: '', label: 'All roles' },
                { value: 'admin', label: 'Admin' },
                { value: 'user', label: 'User' },
              ]}
            />
            <Select
              label="Status"
              value={activeFilter}
              onChange={(e) => { setActiveFilter(e.target.value); setCurrentPage(1); }}
              options={[
                { value: '', label: 'All statuses' },
                { value: 'true', label: 'Active' },
                { value: 'false', label: 'Inactive' },
                { value: 'locked', label: 'Locked' },
              ]}
            />
            <Input
              label="Search"
              placeholder="Search username or email"
              value={searchFilter}
              onChange={(e) => { setSearchFilter(e.target.value); setCurrentPage(1); }}
            />
          </div>
        </div>

        {/* Locked accounts alert */}
        {!loading && lockedUsers.length > 0 && (
          <div className="animate-in-delay rounded-xl border border-amber-300 bg-amber-50 px-5 py-4" style={{ '--stagger': 2 } as React.CSSProperties}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex-shrink-0 flex items-center justify-center w-9 h-9 rounded-lg bg-amber-200/70">
                  <svg className="w-5 h-5 text-amber-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-semibold text-amber-900">
                    {lockedUsers.length} account{lockedUsers.length === 1 ? '' : 's'} locked out
                  </p>
                  <p className="text-xs text-amber-700 mt-0.5">
                    {lockedUsers.map(u => u.username).join(', ')} — locked due to failed login attempts
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {activeFilter !== 'locked' && (
                  <Button size="sm" variant="outline" onClick={() => { setActiveFilter('locked'); setCurrentPage(1); }}>
                    Show Locked
                  </Button>
                )}
                {lockedUsers.length === 1 && (
                  <Button size="sm" variant="primary" onClick={() => handleUnlock(lockedUsers[0])}>
                    Unlock
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* User table */}
        {loading && (
          <div className="animate-in-delay space-y-3" style={{ '--stagger': 2 } as React.CSSProperties}>
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
            </div>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="skeleton h-14 w-full rounded-lg" />
            ))}
          </div>
        )}
        {!loading && isEmptyUsers && (
          <div className="animate-in-delay text-center py-20" style={{ '--stagger': 2 } as React.CSSProperties}>
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-surface-tertiary mb-4">
              {/* eslint-disable-next-line no-restricted-syntax -- decorative empty-state icon, aria-hidden */}
              <svg className="w-8 h-8 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            </div>
            <h3 className="font-display text-lg font-semibold text-ink mb-1">No users found</h3>
            <p className="text-sm text-ink-muted">Try adjusting your filters above.</p>
          </div>
        )}
        {!loading && !isEmptyUsers && (
          <>
            <Card className="animate-in-delay overflow-hidden" style={{ '--stagger': 2 } as React.CSSProperties}>
              <div className="overflow-x-auto -m-6">
                <table className="min-w-full divide-y divide-hairline">
                  <thead className="bg-surface-secondary/80">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">
                        <input
                          type="checkbox"
                          checked={pagedUsers.length > 0 && selectedUserIds.size === pagedUsers.length}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedUserIds(new Set(pagedUsers.map((u) => u.id)));
                            } else {
                              setSelectedUserIds(new Set());
                            }
                          }}
                          className="rounded border-hairline text-accent focus:ring-accent/30"
                        />
                      </th>
                      <SortHeader field="username" label="Username" />
                      <SortHeader field="email" label="Email" />
                      <SortHeader field="role" label="Role" />
                      <SortHeader field="created_at" label="Created" />
                      <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Status</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-hairline">
                    {pagedUsers.map((u) => (
                      <tr key={u.id} className={`hover:bg-surface-secondary/50 transition-colors ${isLocked(u) ? 'bg-amber-50/60' : ''}`}>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          <input
                            type="checkbox"
                            checked={selectedUserIds.has(u.id)}
                            onChange={(e) => {
                              setSelectedUserIds((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(u.id);
                                else next.delete(u.id);
                                return next;
                              });
                            }}
                            className="rounded border-hairline text-accent focus:ring-accent/30"
                          />
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className="text-sm font-medium text-ink">{u.username}</span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-ink-muted">{u.email}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          <Badge variant={u.role === 'admin' ? 'info' : 'default'}>
                            {u.role.toUpperCase()}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-ink-muted">
                          {formatDate(u.created_at)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          <Badge variant={userStatus(u).variant}>
                            {userStatus(u).label}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          <div className="flex gap-1.5">
                            <Button size="sm" variant="outline" onClick={() => openEdit(u)}>Edit</Button>
                            <Button size="sm" variant="outline" onClick={() => openResetPw(u)}>Reset PW</Button>
                            {isActive(u) ? (
                              <>
                                {u.role !== 'admin' && (
                                  <Button size="sm" variant="warning" onClick={() => handleLock(u)}>Lock</Button>
                                )}
                                <Button size="sm" variant="danger" onClick={() => openDelete(u)}>Deactivate</Button>
                              </>
                            ) : (
                              <>
                                {isLocked(u) && (
                                  <Button size="sm" variant="primary" onClick={() => handleUnlock(u)}>Unlock</Button>
                                )}
                                {!isLocked(u) && (
                                  <Button size="sm" variant="secondary" onClick={() => handleReactivate(u)}>Reactivate</Button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            {totalPages > 1 && (
              <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} />
            )}
          </>
        )}
      </div>

      {selectedUserIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-ink text-white px-6 py-3 rounded-xl shadow-premium-lg flex items-center gap-4 text-sm animate-scale-in">
          <span className="font-medium">{selectedUserIds.size} selected</span>
          <div className="w-px h-4 bg-ink" />
          <Button size="sm" variant="danger" onClick={handleBulkDeactivate}>
            Deactivate Selected
          </Button>
          <button
            onClick={() => setSelectedUserIds(new Set())}
            // eslint-disable-next-line no-restricted-syntax -- contrast OK on dark surface (gray-400 on gray-900 = 5.78:1)
            className="text-ink-muted hover:text-white transition-colors ml-1"
            aria-label="Clear selection"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Create User Modal */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create User">
        <div className="space-y-4">
          <Input label="Username" value={formData.username} error={formErrors.username}
            autoFocus
            onChange={(e) => {
              setFormData((f) => ({ ...f, username: e.target.value }));
              if (formErrors.username) setFormErrors((prev) => ({ ...prev, username: '' }));
            }}
            onBlur={(e) => {
              const v = e.target.value;
              if (!v) setFormErrors((prev) => ({ ...prev, username: 'Required' }));
              else if (v.length < 3 || v.length > 50) setFormErrors((prev) => ({ ...prev, username: 'Must be 3-50 characters' }));
            }} />
          <Input label="Email" type="email" value={formData.email} error={formErrors.email}
            onChange={(e) => {
              setFormData((f) => ({ ...f, email: e.target.value }));
              if (formErrors.email) setFormErrors((prev) => ({ ...prev, email: '' }));
            }}
            onBlur={(e) => {
              const v = e.target.value;
              if (!v) setFormErrors((prev) => ({ ...prev, email: 'Required' }));
              else if (!EMAIL_PATTERN.test(v)) setFormErrors((prev) => ({ ...prev, email: 'Invalid email' }));
            }} />
          <Input label="Password" type="password" value={formData.password} error={formErrors.password}
            onChange={(e) => {
              setFormData((f) => ({ ...f, password: e.target.value }));
              if (formErrors.password) setFormErrors((prev) => ({ ...prev, password: '' }));
            }}
            onBlur={(e) => {
              const v = e.target.value;
              if (!v) setFormErrors((prev) => ({ ...prev, password: 'Required' }));
              else if (v.length < 8) setFormErrors((prev) => ({ ...prev, password: 'Min 8 characters' }));
            }} />
          <Select label="Role" value={formData.role}
            onChange={(e) => setFormData((f) => ({ ...f, role: e.target.value }))}
            options={[{ value: 'user', label: 'User' }, { value: 'admin', label: 'Admin' }]} />
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate} disabled={submitting}>
              {submitting ? 'Creating...' : 'Create User'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Edit User Modal */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit User">
        <div className="space-y-4">
          <Input label="Username" value={formData.username} error={formErrors.username}
            autoFocus
            onChange={(e) => {
              setFormData((f) => ({ ...f, username: e.target.value }));
              if (formErrors.username) setFormErrors((prev) => ({ ...prev, username: '' }));
            }}
            onBlur={(e) => {
              const v = e.target.value;
              if (!v) setFormErrors((prev) => ({ ...prev, username: 'Required' }));
              else if (v.length < 3 || v.length > 50) setFormErrors((prev) => ({ ...prev, username: 'Must be 3-50 characters' }));
            }} />
          <Input label="Email" type="email" value={formData.email} error={formErrors.email}
            onChange={(e) => {
              setFormData((f) => ({ ...f, email: e.target.value }));
              if (formErrors.email) setFormErrors((prev) => ({ ...prev, email: '' }));
            }}
            onBlur={(e) => {
              const v = e.target.value;
              if (!v) setFormErrors((prev) => ({ ...prev, email: 'Required' }));
              else if (!EMAIL_PATTERN.test(v)) setFormErrors((prev) => ({ ...prev, email: 'Invalid email' }));
            }} />
          <Input label="New Password (leave blank to keep)" type="password" value={formData.password} error={formErrors.password}
            onChange={(e) => {
              setFormData((f) => ({ ...f, password: e.target.value }));
              if (formErrors.password) setFormErrors((prev) => ({ ...prev, password: '' }));
            }}
            onBlur={(e) => {
              const v = e.target.value;
              if (v && v.length < 8) setFormErrors((prev) => ({ ...prev, password: 'Min 8 characters' }));
            }} />
          <Select label="Role" value={formData.role}
            onChange={(e) => setFormData((f) => ({ ...f, role: e.target.value }))}
            options={[{ value: 'user', label: 'User' }, { value: 'admin', label: 'Admin' }]} />
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleEdit} disabled={submitting}>
              {submitting ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation */}
      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Deactivate User">
        <div className="space-y-4">
          <p className="text-ink-muted">
            Are you sure you want to deactivate <span className="font-semibold text-ink">{selectedUser?.username}</span>?
            They will no longer be able to log in.
          </p>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={handleDelete} disabled={submitting}>
              {submitting ? 'Deactivating...' : 'Deactivate'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Reset Password Modal */}
      <Modal open={resetPwOpen} onClose={() => setResetPwOpen(false)} title="Reset Password">
        <div className="space-y-4">
          <p className="text-ink-muted">
            Set a new password for <span className="font-semibold text-ink">{selectedUser?.username}</span>.
          </p>
          <Input label="New Password" type="password" value={newPassword} error={formErrors.password}
            autoFocus
            onChange={(e) => {
              setNewPassword(e.target.value);
              if (formErrors.password) setFormErrors((prev) => ({ ...prev, password: '' }));
            }}
            onBlur={(e) => {
              const v = e.target.value;
              if (!v) setFormErrors((prev) => ({ ...prev, password: 'Required' }));
              else if (v.length < 8) setFormErrors((prev) => ({ ...prev, password: 'Min 8 characters' }));
            }} />
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setResetPwOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleResetPassword} disabled={submitting}>
              {submitting ? 'Resetting...' : 'Reset Password'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Import Users Modal */}
      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="Import Users">
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">
            Upload a CSV or XLSX file with columns: <code className="text-xs bg-surface-tertiary px-1 py-0.5 rounded">username</code>, <code className="text-xs bg-surface-tertiary px-1 py-0.5 rounded">email</code>, <code className="text-xs bg-surface-tertiary px-1 py-0.5 rounded">role</code> (optional), <code className="text-xs bg-surface-tertiary px-1 py-0.5 rounded">password</code> (optional).
          </p>
          <p className="text-xs text-ink-muted">
            Existing users (matched by email) will be updated. New users will be created with a temporary password.
          </p>

          <div className="border-2 border-dashed border-hairline rounded-lg p-6 text-center">
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={(e) => { setImportFile(e.target.files?.[0] || null); setImportResult(null); }}
              className="block w-full text-sm text-ink-muted file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-accent-50 file:text-accent hover:file:bg-accent-100"
            />
          </div>

          {importFile && !importResult && (
            <p className="text-sm text-ink">
              Selected: <span className="font-medium">{importFile.name}</span> ({(importFile.size / 1024).toFixed(1)} KB)
            </p>
          )}

          {importResult && (
            <div className="space-y-2">
              <div className="flex gap-4 text-sm">
                <span className="text-green-700 font-medium">{importResult.created} created</span>
                <span className="text-accent font-medium">{importResult.updated} updated</span>
                {importResult.errors.length > 0 && (
                  <span className="text-red-700 font-medium">{importResult.errors.length} errors</span>
                )}
              </div>
              {importResult.errors.length > 0 && (
                <div className="max-h-40 overflow-y-auto bg-red-50 rounded-lg p-3">
                  {importResult.errors.map((e) => (
                    <p key={`row-${e.row}-${e.error}`} className="text-xs text-red-700">Row {e.row}: {e.error}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex justify-between pt-2">
            <Button variant="outline" size="sm" onClick={async () => {
              try { await apiClient.downloadExport('/admin/users/import-template', 'user-import-template.xlsx'); }
              catch (err) { showToast(err instanceof Error ? err.message : 'Template download failed', 'error'); }
            }}>
              Download Template
            </Button>
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setImportOpen(false)}>
                {importResult ? 'Close' : 'Cancel'}
              </Button>
              {!importResult && (
                <Button
                  variant="primary"
                  disabled={!importFile || importing}
                  onClick={async () => {
                    if (!importFile) return;
                    setImporting(true);
                    try {
                      const result = await apiClient.importUsers(importFile);
                      setImportResult({ created: result.created, updated: result.updated, errors: result.errors });
                      if (result.created > 0 || result.updated > 0) {
                        loadUsers();
                      }
                      showToast(`Import complete: ${result.created} created, ${result.updated} updated`, 'success');
                    } catch (err) {
                      showToast(err instanceof Error ? err.message : 'Import failed', 'error');
                    } finally {
                      setImporting(false);
                    }
                  }}
                >
                  {importing ? 'Importing...' : 'Import'}
                </Button>
              )}
            </div>
          </div>
        </div>
      </Modal>
    </MainLayout>
  );
}

export default function AdminUsersPage() {
  return (
    <Suspense fallback={
      <div className="min-h-dvh bg-surface-secondary/50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent mx-auto" />
      </div>
    }>
      <AdminUsersPageInner />
    </Suspense>
  );
}
