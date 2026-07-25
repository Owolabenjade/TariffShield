// Next.js route-level Suspense boundary (issue #256) — automatically wraps
// app/app/page.tsx so the server can stream this skeleton as the initial
// HTML response immediately, before the client component hydrates and
// fetches importer data. See the note in page.tsx for why the page itself
// stays a Client Component rather than an async Server Component.
export default function Loading() {
  return (
    <main className="max-w-5xl mx-auto px-6 py-10 animate-pulse">
      <div className="h-4 w-24 rounded bg-border" />
      <div className="mt-2 h-7 w-64 rounded bg-border" />
      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-20 rounded-lg border border-border bg-card" />
        ))}
      </div>
      <div className="mt-4 h-16 rounded-lg border border-border bg-card" />
    </main>
  );
}
