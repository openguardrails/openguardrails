import { Outlet } from "react-router-dom";
import { Topbar } from "./Topbar";
import { Sidebar } from "./Sidebar";

export function Shell() {
  return (
    <div className="shell">
      <Topbar />
      <Sidebar />
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
