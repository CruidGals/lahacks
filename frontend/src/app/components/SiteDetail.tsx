import { Link, useParams } from "react-router";
import { ArrowLeft, MapPin, DollarSign, AlertCircle } from "lucide-react";

const SITE_DATA = {
  1: {
    id: 1,
    title: "Industrial Waste Site",
    image: "https://images.unsplash.com/photo-1611284446314-60a58ac0deb9?w=800&h=600&fit=crop",
    coordinates: "40.7128° N, 74.0060° W",
    bounty: 850,
    contributors: 12,
    urgency: "critical",
    brand: "Coca-Cola",
    brandItemCount: 14,
    description: "Large accumulation of industrial waste including plastic containers and packaging materials.",
    estimatedBags: 15,
    reportedDate: "2026-04-20",
  },
};

export function SiteDetail() {
  const { id } = useParams();
  const site = SITE_DATA[id as keyof typeof SITE_DATA] || SITE_DATA[1];

  return (
    <div className="h-full flex flex-col bg-[#0a0a0a]">
      {/* Header */}
      <div className="bg-black border-b border-[#2a2a2a] p-4 flex items-center gap-3">
        <Link to="/" className="hover:text-[#c5ff3d] transition-colors">
          <ArrowLeft className="w-6 h-6" />
        </Link>
        <h1 className="text-lg font-bold">Site Details</h1>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Hero Image */}
        <div className="relative w-full h-64 bg-[#151515]">
          <img
            src={site.image}
            alt={site.title}
            className="w-full h-full object-cover"
          />
          <div className="absolute top-3 right-3">
            <div
              className={`px-3 py-1.5 rounded font-bold text-sm ${
                site.urgency === "critical"
                  ? "bg-red-900/80 text-red-400 border border-red-700"
                  : "bg-yellow-900/80 text-yellow-400 border border-yellow-700"
              }`}
            >
              {site.urgency.toUpperCase()}
            </div>
          </div>
        </div>

        {/* Info Cards */}
        <div className="p-4 space-y-4">
          {/* Title & Location */}
          <div>
            <h2 className="text-2xl font-bold mb-2">{site.title}</h2>
            <div className="flex items-center gap-2 text-gray-400">
              <MapPin className="w-4 h-4" />
              <span className="text-sm">{site.coordinates}</span>
            </div>
          </div>

          {/* Bounty Card */}
          <div className="bg-[#1a1a1a] border-2 border-[#c5ff3d] rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm text-gray-400 mb-1">Total Bounty</p>
                <div className="flex items-baseline gap-1">
                  <DollarSign className="w-8 h-8 text-[#c5ff3d]" />
                  <span className="text-5xl font-bold text-[#c5ff3d]">{site.bounty}</span>
                </div>
              </div>
              <div className="flex -space-x-2">
                {[...Array(Math.min(4, site.contributors))].map((_, i) => (
                  <div
                    key={i}
                    className="w-10 h-10 rounded-full bg-[#c5ff3d]/20 border-2 border-[#0a0a0a] flex items-center justify-center"
                  >
                    <span className="text-xs font-bold text-[#c5ff3d]">
                      {String.fromCharCode(65 + i)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <p className="text-sm text-gray-400">{site.contributors} contributors stacked bounty</p>
          </div>

          {/* Brand Accountability */}
          <div className="bg-[#1a1a1a] border border-orange-700 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-orange-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-orange-400 mb-1">Brand Accountability Alert</p>
                <p className="text-sm text-gray-300">
                  <span className="font-bold">{site.brandItemCount} {site.brand}</span> items identified at this site
                </p>
              </div>
            </div>
          </div>

          {/* Site Details */}
          <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-4 space-y-3">
            <div>
              <p className="text-sm text-gray-400 mb-1">Description</p>
              <p className="text-sm">{site.description}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-sm text-gray-400 mb-1">Estimated Bags</p>
                <p className="text-xl font-bold">{site.estimatedBags}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400 mb-1">Reported</p>
                <p className="text-xl font-bold">{new Date(site.reportedDate).toLocaleDateString()}</p>
              </div>
            </div>
          </div>

          {/* CTA */}
          <Link
            to="/submit"
            className="block w-full bg-[#c5ff3d] text-black py-4 rounded-lg font-bold text-center hover:bg-[#d4ff5d] transition-colors"
          >
            Claim Bounty
          </Link>
        </div>
      </div>
    </div>
  );
}
