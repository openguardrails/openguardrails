export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="container-x">
      <main className="min-w-0 mx-auto py-12 max-w-3xl">{children}</main>
    </div>
  );
}
