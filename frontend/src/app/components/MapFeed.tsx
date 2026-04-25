import { Link } from "react-router";
import { MapPin, DollarSign, AlertTriangle, Users } from "lucide-react";

const DUMP_SITES = [
  {
    id: 1,
    lat: 40.7128,
    lng: -74.006,
    bounty: 850,
    urgency: "critical",
    title: "Industrial Waste Site",
    thumbnail: "https://images.unsplash.com/photo-1611284446314-60a58ac0deb9?w=400&h=300&fit=crop",
    contributors: 12,
  },
  {
    id: 2,
    lat: 40.7489,
    lng: -73.9681,
    bounty: 420,
    urgency: "active",
    title: "Riverside Dump Zone",
    thumbnail: "https://images.unsplash.com/photo-1621451537084-482c73073a0f?w=400&h=300&fit=crop",
    contributors: 7,
  },
  {
    id: 3,
    lat: 40.7614,
    lng: -73.9776,
    bounty: 1200,
    urgency: "critical",
    title: "Highway Debris Field",
    thumbnail: "https://images.unsplash.com/photo-1618477461853-cf6ed80faba5?w=400&h=300&fit=crop",
    contributors: 18,
  },
  {
    id: 4,
    lat: 40.7282,
    lng: -73.9942,
    bounty: 220,
    urgency: "new",
    title: "Park Overflow",
    thumbnail: "https://images.unsplash.com/photo-1621451537084-482c73073a0f?w=400&h=300&fit=crop",
    contributors: 3,
  },
];

export function MapFeed() {
  return (
    <div className="h-full flex flex-col">
      {/* Map Area */}
      <div className="flex-1 relative bg-[#151515]">
        {/* Simulated map with pins */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative w-full h-full">
            {/* Map background pattern */}
            <div className="absolute inset-0 opacity-20">
              <svg width="100%" height="100%">
                <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                  <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#333" strokeWidth="0.5" />
                </pattern>
                <rect width="100%" height="100%" fill="url(#grid)" />
              </svg>
            </div>

            {/* Bounty pins */}
            {DUMP_SITES.map((site, idx) => (
              <Link
                key={site.id}
                to={`/site/${site.id}`}
                className="absolute"
                style={{
                  left: `${20 + idx * 18}%`,
                  top: `${30 + (idx % 2) * 20}%`,
                }}
              >
                <div className="relative group">
                  <div className="w-12 h-12 bg-[#c5ff3d] rounded-full flex items-center justify-center shadow-lg shadow-[#c5ff3d]/30 group-hover:scale-110 transition-transform">
                    <MapPin className="w-6 h-6 text-black" />
                  </div>
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-black/90 px-2 py-1 rounded whitespace-nowrap border border-[#c5ff3d]">
                    <span className="font-bold text-[#c5ff3d]">${site.bounty}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>

        {/* Header overlay */}
        <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/80 to-transparent">
          <h1 className="text-2xl font-bold tracking-tight">DumpBounty</h1>
          <p className="text-sm text-gray-400 mt-1">Crowdsourced cleanup marketplace</p>
        </div>
      </div>

      {/* Bottom sheet */}
      <div className="bg-[#0a0a0a] border-t-2 border-[#c5ff3d] max-h-[50vh] overflow-y-auto">
        <div className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold">Nearby Sites</h2>
            <span className="text-sm text-gray-400">{DUMP_SITES.length} active</span>
          </div>

          <div className="space-y-3">
            {DUMP_SITES.map((site) => (
              <Link
                key={site.id}
                to={`/site/${site.id}`}
                className="block bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg overflow-hidden hover:border-[#c5ff3d] transition-colors"
              >
                <div className="flex gap-3 p-3">
                  {/* Thumbnail */}
                  <div className="w-20 h-20 bg-[#252525] rounded overflow-hidden flex-shrink-0">
                    <img
                      src={site.thumbnail}
                      alt={site.title}
                      className="w-full h-full object-cover"
                    />
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <h3 className="font-bold truncate">{site.title}</h3>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-bold flex-shrink-0 ${
                          site.urgency === "critical"
                            ? "bg-red-900/30 text-red-400 border border-red-700"
                            : site.urgency === "active"
                            ? "bg-yellow-900/30 text-yellow-400 border border-yellow-700"
                            : "bg-blue-900/30 text-blue-400 border border-blue-700"
                        }`}
                      >
                        {site.urgency.toUpperCase()}
                      </span>
                    </div>

                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-1">
                        <DollarSign className="w-5 h-5 text-[#c5ff3d]" />
                        <span className="text-2xl font-bold text-[#c5ff3d]">{site.bounty}</span>
                      </div>
                      <div className="flex items-center gap-1 text-sm text-gray-400">
                        <div className="flex -space-x-1">
                          {[...Array(Math.min(3, site.contributors))].map((_, i) => (
                            <div
                              key={i}
                              className="w-6 h-6 rounded-full bg-[#c5ff3d]/20 border-2 border-[#0a0a0a]"
                            />
                          ))}
                        </div>
                        <span>{site.contributors} contributors</span>
                      </div>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Nav bar */}
      <div className="bg-black border-t border-[#2a2a2a] p-4">
        <div className="flex justify-around">
          <button className="flex flex-col items-center gap-1 text-[#c5ff3d]">
            <MapPin className="w-6 h-6" />
            <span className="text-xs font-bold">Map</span>
          </button>
          <Link to="/volunteer" className="flex flex-col items-center gap-1 text-gray-400 hover:text-white transition-colors">
            <Users className="w-6 h-6" />
            <span className="text-xs">Volunteer</span>
          </Link>
          <Link to="/submit" className="flex flex-col items-center gap-1 text-gray-400 hover:text-white transition-colors">
            <AlertTriangle className="w-6 h-6" />
            <span className="text-xs">Submit</span>
          </Link>
          <Link to="/profile/1" className="flex flex-col items-center gap-1 text-gray-400 hover:text-white transition-colors">
            <div className="w-6 h-6 rounded-full bg-[#c5ff3d]/20" />
            <span className="text-xs">Profile</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
