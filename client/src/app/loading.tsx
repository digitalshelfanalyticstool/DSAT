export default function Loading() {
  return (
    <div className="min-h-dvh bg-surface-secondary animate-pulse">
      <div className="flex">
        {/* Sidebar spacer — matches expanded sidebar width on lg+ */}
        <div className="hidden lg:block w-64 min-h-dvh bg-surface border-r border-hairline/60" />

        {/* Main content skeletons */}
        <div className="flex-1 p-8">
          <div className="space-y-8">
            <div className="flex items-center justify-between">
              <div>
                <div className="skeleton h-9 w-48 mb-2" />
                <div className="skeleton h-5 w-64" />
              </div>
              <div className="skeleton h-12 w-40 rounded-md" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {[0, 1, 2].map((i) => (
                <div key={i} className="surface-card p-6">
                  <div className="skeleton h-4 w-20 mb-3" />
                  <div className="skeleton h-8 w-24" />
                </div>
              ))}
            </div>
            <div className="space-y-3">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton h-20 w-full rounded-xl" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
