import { createBrowserRouter } from "react-router";
import { MapFeed } from "./components/MapFeed";
import { SiteDetail } from "./components/SiteDetail";
import { CleanupSubmission } from "./components/CleanupSubmission";
import { CrewProfile } from "./components/CrewProfile";
import { VolunteerHub } from "./components/VolunteerHub";
import { Root } from "./components/Root";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Root,
    children: [
      { index: true, Component: MapFeed },
      { path: "site/:id", Component: SiteDetail },
      { path: "submit", Component: CleanupSubmission },
      { path: "volunteer", Component: VolunteerHub },
      { path: "profile/:id", Component: CrewProfile },
    ],
  },
]);
