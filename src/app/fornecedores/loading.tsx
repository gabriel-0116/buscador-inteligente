export default function Loading() {
  return (
    <main className="mx-auto flex max-w-screen-xl flex-col gap-6 px-4 py-10 md:px-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="h-7 w-48 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
          <div className="h-4 w-72 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
        </div>
        <div className="h-9 w-36 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-12 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900"
          />
        ))}
      </div>
    </main>
  );
}
