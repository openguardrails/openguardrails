export function PlaceholderPage({ section }: { section: string }) {
  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="page-title">{section}</h1>
          <p className="page-sub">Coming soon</p>
        </div>
      </div>
      <div className="card">
        <div className="card-title">{section}</div>
        <div className="card-sub">
          This section is under development. Stay tuned.
        </div>
      </div>
    </>
  );
}
