import Link from "next/link";

export type BreadcrumbItem = {
  label: string;
  href?: string;
};

export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1.5 text-sm">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={i} className="flex items-center gap-1.5">
              {item.href && !isLast ? (
                <Link
                  href={item.href}
                  className="block max-w-[180px] truncate text-zinc-500 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:text-zinc-400 dark:hover:text-zinc-100"
                  title={item.label}
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={isLast ? "page" : undefined}
                  className={
                    isLast
                      ? "block max-w-[180px] truncate text-zinc-900 dark:text-zinc-100"
                      : "block max-w-[180px] truncate text-zinc-500 dark:text-zinc-400"
                  }
                  title={item.label}
                >
                  {item.label}
                </span>
              )}
              {!isLast && (
                <span
                  aria-hidden="true"
                  className="text-zinc-300 dark:text-zinc-700"
                >
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
