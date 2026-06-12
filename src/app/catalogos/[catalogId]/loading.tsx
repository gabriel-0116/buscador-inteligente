export default function Loading() {
  return (
    <main className="mx-auto flex max-w-screen-xl flex-col gap-8 px-4 py-10 md:px-6">
      <div className="flex flex-col gap-2">
        <div className="h-4 w-64 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
        <div className="h-7 w-80 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-900"
          />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="aspect-[3/4] animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-900"
          />
        ))}
      </div>
    </main>
  );
}
