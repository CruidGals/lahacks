import { Outlet } from "react-router";

export function Root() {
  return (
    <div className="h-screen w-full bg-[#0a0a0a] text-white overflow-hidden">
      <Outlet />
    </div>
  );
}
