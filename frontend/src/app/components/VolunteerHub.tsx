import { useState } from "react";
import { Link } from "react-router";
import { MapPin, Clock, Users } from "lucide-react";

type FilterOption = "today" | "week" | "near" | "all";

const OPPORTUNITIES = [
  {
    id: 1,
    org: "Downtown Community Kitchen",
    activity: "Meal Service",
    type: "Soup Kitchen",
    date: "2026-04-25",
    time: "5:00 PM - 8:00 PM",
    distance: 0.8,
    spotsRemaining: 3,
    totalSpots: 8,
  },
  {
    id: 2,
    org: "River Valley Food Bank",
    activity: "Food Sorting & Distribution",
    type: "Food Bank",
    date: "2026-04-26",
    time: "9:00 AM - 12:00 PM",
    distance: 1.2,
    spotsRemaining: 5,
    totalSpots: 10,
  },
  {
    id: 3,
    org: "Green Future Initiative",
    activity: "Tree Planting Drive",
    type: "Park Cleanup",
    date: "2026-04-27",
    time: "8:00 AM - 2:00 PM",
    distance: 2.5,
    spotsRemaining: 12,
    totalSpots: 20,
  },
  {
    id: 4,
    org: "Urban Garden Collective",
    activity: "Spring Garden Prep",
    type: "Community Garden",
    date: "2026-04-25",
    time: "10:00 AM - 1:00 PM",
    distance: 1.8,
    spotsRemaining: 6,
    totalSpots: 12,
  },
  {
    id: 5,
    org: "Sunset Senior Center",
    activity: "Tech Help Sessions",
    type: "Senior Support",
    date: "2026-04-28",
    time: "2:00 PM - 5:00 PM",
    distance: 3.1,
    spotsRemaining: 2,
    totalSpots: 4,
  },
  {
    id: 6,
    org: "Neighborhood Park Alliance",
    activity: "Trail Maintenance",
    type: "Park Cleanup",
    date: "2026-04-29",
    time: "7:00 AM - 11:00 AM",
    distance: 1.5,
    spotsRemaining: 8,
    totalSpots: 15,
  },
];

export function VolunteerHub() {
  const [filter, setFilter] = useState<FilterOption>("all");

  const getTypeColor = (type: string) => {
    switch (type) {
      case "Soup Kitchen":
        return "bg-amber-900/30 text-amber-400 border-amber-700";
      case "Food Bank":
        return "bg-orange-900/30 text-orange-400 border-orange-700";
      case "Park Cleanup":
        return "bg-green-900/30 text-green-400 border-green-700";
      case "Community Garden":
        return "bg-lime-900/30 text-lime-400 border-lime-700";
      default:
        return "bg-amber-900/30 text-amber-400 border-amber-700";
    }
  };

  const isToday = (date: string) => {
    return date === "2026-04-25";
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-black border-b border-[#2a2a2a] p-4">
        <h1 className="text-2xl font-bold tracking-tight">Volunteer Hub</h1>
        <p className="text-sm text-gray-400 mt-1">Local community opportunities</p>
      </div>

      {/* Filter Row */}
      <div className="bg-[#0a0a0a] border-b border-[#2a2a2a] p-3">
        <div className="flex gap-2 overflow-x-auto">
          {[
            { value: "today" as FilterOption, label: "Today" },
            { value: "week" as FilterOption, label: "This Week" },
            { value: "near" as FilterOption, label: "Near Me" },
            { value: "all" as FilterOption, label: "All" },
          ].map((option) => (
            <button
              key={option.value}
              onClick={() => setFilter(option.value)}
              className={`px-4 py-2 rounded-lg font-bold text-sm whitespace-nowrap transition-colors ${
                filter === option.value
                  ? "bg-amber-600 text-black"
                  : "bg-[#1a1a1a] text-gray-400 border border-[#2a2a2a] hover:border-amber-600"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Opportunities Feed */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {OPPORTUNITIES.map((opp) => (
          <div
            key={opp.id}
            className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-4 hover:border-amber-600/50 transition-colors"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="flex-1">
                <h3 className="font-bold text-lg mb-1">{opp.org}</h3>
                <p className="text-sm text-gray-300">{opp.activity}</p>
              </div>
              <span
                className={`px-2 py-1 rounded text-xs font-bold border flex-shrink-0 ${getTypeColor(
                  opp.type
                )}`}
              >
                {opp.type}
              </span>
            </div>

            {/* Details Grid */}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div className="flex items-center gap-2 text-sm">
                <Clock className="w-4 h-4 text-amber-500" />
                <div>
                  <p className="text-gray-400 text-xs">
                    {isToday(opp.date) ? "Today" : new Date(opp.date).toLocaleDateString()}
                  </p>
                  <p className="text-white">{opp.time}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <MapPin className="w-4 h-4 text-amber-500" />
                <div>
                  <p className="text-gray-400 text-xs">Distance</p>
                  <p className="text-white">{opp.distance} mi</p>
                </div>
              </div>
            </div>

            {/* Spots & CTA */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm">
                <Users className="w-4 h-4 text-gray-400" />
                <span className="text-gray-400">
                  <span className="text-amber-500 font-bold">{opp.spotsRemaining}</span> of{" "}
                  {opp.totalSpots} spots
                </span>
              </div>
              <button className="bg-amber-600 text-black px-4 py-2 rounded-lg font-bold text-sm hover:bg-amber-500 transition-colors">
                Sign Up
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Nav bar */}
      <div className="bg-black border-t border-[#2a2a2a] p-4">
        <div className="flex justify-around">
          <Link
            to="/"
            className="flex flex-col items-center gap-1 text-gray-400 hover:text-white transition-colors"
          >
            <MapPin className="w-6 h-6" />
            <span className="text-xs">Map</span>
          </Link>
          <button className="flex flex-col items-center gap-1 text-amber-500">
            <Users className="w-6 h-6" />
            <span className="text-xs font-bold">Volunteer</span>
          </button>
          <Link
            to="/submit"
            className="flex flex-col items-center gap-1 text-gray-400 hover:text-white transition-colors"
          >
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            <span className="text-xs">Submit</span>
          </Link>
          <Link
            to="/profile/1"
            className="flex flex-col items-center gap-1 text-gray-400 hover:text-white transition-colors"
          >
            <div className="w-6 h-6 rounded-full bg-[#c5ff3d]/20" />
            <span className="text-xs">Profile</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
