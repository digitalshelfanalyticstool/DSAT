'use client';

import { useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { Card, Button, Badge, Input, Select, Modal } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { apiClient } from '@/lib/api-client';
import type { GlobalMessage } from '@/lib/api-client';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { useAsyncResource } from '@/hooks/useAsyncResource';
import { formatDateTime } from '@/lib/format';

interface MessageFormData {
  title: string;
  message: string;
  type: string;
  expires_at: string;
}

const EMPTY_FORM: MessageFormData = { title: '', message: '', type: 'info', expires_at: '' };

export default function AdminMessagesPage() {
  const { authChecked } = useRequireAuth({ role: 'admin' });
  const { showToast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedMsg, setSelectedMsg] = useState<GlobalMessage | null>(null);
  const [formData, setFormData] = useState<MessageFormData>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const { data, loading, refetch: loadMessages } = useAsyncResource(
    () => apiClient.getMessages(),
    {
      auto: authChecked,
      onError: (err) => showToast(err.message || 'Failed to load messages', 'error'),
    },
  );
  const messages = data?.messages ?? [];

  const handleCreate = async () => {
    if (!formData.message.trim()) {
      showToast('Message body is required', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const payload: { title?: string; message: string; type: string; expires_at?: number | null } = {
        message: formData.message,
        type: formData.type,
      };
      if (formData.title.trim()) payload.title = formData.title.trim();
      if (formData.expires_at) {
        payload.expires_at = Math.floor(new Date(formData.expires_at).getTime() / 1000);
      }
      await apiClient.createMessage(payload);
      showToast('Message created', 'success');
      setCreateOpen(false);
      setFormData(EMPTY_FORM);
      await loadMessages();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to create message', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (msg: GlobalMessage) => {
    setSelectedMsg(msg);
    setFormData({
      title: msg.title || '',
      message: msg.message,
      type: msg.type,
      expires_at: msg.expires_at ? new Date(msg.expires_at * 1000).toISOString().slice(0, 16) : '',
    });
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!selectedMsg || !formData.message.trim()) {
      showToast('Message body is required', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const updates: Record<string, unknown> = {
        title: formData.title.trim() || null,
        message: formData.message,
        type: formData.type,
        expires_at: formData.expires_at ? Math.floor(new Date(formData.expires_at).getTime() / 1000) : null,
      };
      await apiClient.updateMessage(selectedMsg.id, updates);
      showToast('Message updated', 'success');
      setEditOpen(false);
      await loadMessages();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update message', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleActive = async (msg: GlobalMessage) => {
    try {
      await apiClient.updateMessage(msg.id, { active: msg.active !== 1 });
      showToast(msg.active === 1 ? 'Message deactivated' : 'Message activated', 'success');
      await loadMessages();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to toggle message', 'error');
    }
  };

  const openDelete = (msg: GlobalMessage) => { setSelectedMsg(msg); setDeleteOpen(true); };

  const handleDelete = async () => {
    if (!selectedMsg) return;
    setSubmitting(true);
    try {
      await apiClient.deleteMessage(selectedMsg.id);
      showToast('Message deleted', 'success');
      setDeleteOpen(false);
      await loadMessages();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete message', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const typeBadgeVariant = (type: string) => {
    switch (type) {
      case 'warning': return 'warning' as const;
      case 'error': return 'error' as const;
      default: return 'info' as const;
    }
  };

  const formatDate = (ts: number) => formatDateTime(ts * 1000);

  if (!authChecked) {
    return (
      <div className="min-h-dvh bg-surface-secondary flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent mx-auto" />
      </div>
    );
  }

  const messageFormJsx = (
    <div className="space-y-4">
      <Input
        label="Title (optional)"
        value={formData.title}
        onChange={(e) => setFormData((f) => ({ ...f, title: e.target.value }))}
        placeholder="Message title"
      />
      <div>
        <label htmlFor="admin-message-body" className="block text-sm font-medium text-ink mb-1">
          Message
        </label>
        <textarea
          id="admin-message-body"
          className="w-full px-3 py-2 border border-hairline rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent"
          rows={3}
          value={formData.message}
          onChange={(e) => setFormData((f) => ({ ...f, message: e.target.value }))}
          placeholder="Message body"
        />
      </div>
      <Select
        label="Type"
        value={formData.type}
        onChange={(e) => setFormData((f) => ({ ...f, type: e.target.value }))}
        options={[
          { value: 'info', label: 'Info' },
          { value: 'warning', label: 'Warning' },
          { value: 'error', label: 'Error' },
        ]}
      />
      <Input
        label="Expires at (optional)"
        type="datetime-local"
        value={formData.expires_at}
        onChange={(e) => setFormData((f) => ({ ...f, expires_at: e.target.value }))}
      />
    </div>
  );

  return (
    <MainLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-ink">Global Messages</h1>
            <p className="mt-1 text-ink-muted">{messages.length} message{messages.length === 1 ? '' : 's'}</p>
          </div>
          <Button variant="primary" onClick={() => { setFormData(EMPTY_FORM); setCreateOpen(true); }}>
            Create Message
          </Button>
        </div>

        {loading && (
          <Card><div className="text-center py-8">Loading messages...</div></Card>
        )}
        {!loading && messages.length === 0 && (
          <Card><div className="text-center py-8 text-ink-muted">No messages yet.</div></Card>
        )}
        {!loading && messages.length > 0 && (
          <Card className="overflow-x-auto">
            <table className="min-w-full divide-y divide-hairline">
              <thead className="bg-surface-secondary">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Title</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Message</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Type</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Author</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Created</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-hairline">
                {messages.map((msg) => (
                  <tr key={msg.id} className="hover:bg-surface-secondary">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-ink">
                      {msg.title || '—'}
                    </td>
                    <td className="px-6 py-4 text-sm text-ink-muted max-w-xs truncate">
                      {msg.message}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <Badge variant={typeBadgeVariant(msg.type)}>{msg.type.toUpperCase()}</Badge>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <Badge variant={msg.active === 1 ? 'success' : 'default'}>
                        {msg.active === 1 ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-ink-muted">
                      {msg.author || '—'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-ink-muted">
                      {formatDate(msg.created_at)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => openEdit(msg)}>Edit</Button>
                        <Button size="sm" variant="secondary" onClick={() => handleToggleActive(msg)}>
                          {msg.active === 1 ? 'Deactivate' : 'Activate'}
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => openDelete(msg)}>Delete</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create Message">
        {messageFormJsx}
        <div className="flex justify-end gap-3 pt-4">
          <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={handleCreate} disabled={submitting}>
            {submitting ? 'Creating...' : 'Create'}
          </Button>
        </div>
      </Modal>

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit Message">
        {messageFormJsx}
        <div className="flex justify-end gap-3 pt-4">
          <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={handleEdit} disabled={submitting}>
            {submitting ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </Modal>

      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete Message">
        <p className="text-ink">
          Are you sure you want to delete this message? This action cannot be undone.
        </p>
        <div className="flex justify-end gap-3 pt-4">
          <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete} disabled={submitting}>
            {submitting ? 'Deleting...' : 'Delete'}
          </Button>
        </div>
      </Modal>
    </MainLayout>
  );
}
