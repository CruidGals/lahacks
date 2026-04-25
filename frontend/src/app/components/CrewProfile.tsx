import { Link, useParams } from "react-router";
import { ArrowLeft, Award, DollarSign, Trash2, CheckCircle, Heart } from "lucide-react";

const PROFILE_DATA = {
  1: {
    id: 1,
    name: "Urban Cleanup Crew",
    avatar: "UC",
    reputation: 4.8,
    totalEarned: 12450,
    cleanupsCompleted: 42,
    volunteerHours: 78,
    badges: [
      { name: "City Contractor Ready", icon: "🏆", color: "text-yellow-400" },
      { name: "100+ Bags Collected", icon: "💪", color: "text-blue-400" },
      { name: "Brand Hunter", icon: "🎯", color: "text-green-400" },
      { name: "50hrs Volunteered", icon: "❤️", color: "text-amber-400" },
      { name: "Community Hero", icon: "🌟", color: "text-orange-400" },
    ],
    recentJobs: [
      {
        id: 1,
        site: "Industrial Waste Site",
        date: "2026-04-20",
        earned: 850,
        status: "verified",
        image: "https://images.unsplash.com/photo-1611284446314-60a58ac0deb9?w=400&h=300&fit=crop",
      },
      {
        id: 2,
        site: "Riverside Dump Zone",
        date: "2026-04-15",
        earned: 420,
        status: "verified",
        image: "https://images.unsplash.com/photo-1621451537084-482c73073a0f?w=400&h=300&fit=crop",
      },
      {
        id: 3,
        site: "Highway Debris Field",
        date: "2026-04-10",
        earned: 1200,
        status: "verified",
        image: "https://images.unsplash.com/photo-1618477461853-cf6ed80faba5?w=400&h=300&fit=crop",
      },
    ],
  },
};

export function CrewProfile() {
  const { id } = useParams();
  const profile = PROFILE_DATA[id as keyof typeof PROFILE_DATA] || PROFILE_DATA[1];

  return (
    <div className="h-full flex flex-col bg-[#0a0a0a]">
      {/* Header */}
      <div className="bg-black border-b border-[#2a2a2a] p-4 flex items-center gap-3">
        <Link to="/" className="hover:text-[#c5ff3d] transition-colors">
          <ArrowLeft className="w-6 h-6" />
        </Link>
        <h1 className="text-lg font-bold">Crew Profile</h1>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Profile Header */}
        <div className="bg-[#1a1a1a] border-b border-[#2a2a2a] p-6">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-20 h-20 rounded-full bg-[#c5ff3d] flex items-center justify-center">
              <span className="text-3xl font-bold text-black">{profile.avatar}</span>
            </div>
            <div>
              <h2 className="text-2xl font-bold mb-1">{profile.name}</h2>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1">
                  {[...Array(5)].map((_, i) => (
                    <span
                      key={i}
                      className={`text-lg ${
                        i < Math.floor(profile.reputation) ? "text-[#c5ff3d]" : "text-gray-600"
                      }`}
                    >
                      ★
                    </span>
                  ))}
                </div>
                <span className="text-sm text-gray-400">{profile.reputation}/5.0</span>
              </div>
            </div>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg p-3">
              <p className="text-sm text-gray-400 mb-1">Total Earned</p>
              <div className="flex items-baseline gap-1">
                <DollarSign className="w-5 h-5 text-[#c5ff3d]" />
                <span className="text-2xl font-bold text-[#c5ff3d]">
                  {profile.totalEarned.toLocaleString()}
                </span>
              </div>
            </div>
            <div className="bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg p-3">
              <p className="text-sm text-gray-400 mb-1">Cleanups</p>
              <div className="flex items-baseline gap-1">
                <Trash2 className="w-5 h-5 text-[#c5ff3d]" />
                <span className="text-2xl font-bold text-white">{profile.cleanupsCompleted}</span>
              </div>
            </div>
          </div>
          <div className="bg-gradient-to-r from-amber-900/30 to-orange-900/30 border border-amber-700/50 rounded-lg p-3">
            <p className="text-sm text-amber-400/80 mb-1">Volunteer Hours</p>
            <div className="flex items-baseline gap-1">
              <Heart className="w-5 h-5 text-amber-500" />
              <span className="text-2xl font-bold text-amber-400">{profile.volunteerHours}</span>
              <span className="text-sm text-amber-400/60 ml-1">hours</span>
            </div>
          </div>
        </div>

        <div className="p-4 space-y-4">
          {/* Badges */}
          <div>
            <h3 className="font-bold mb-3 flex items-center gap-2">
              <Award className="w-5 h-5 text-[#c5ff3d]" />
              Badges
            </h3>
            <div className="space-y-2">
              {profile.badges.map((badge, idx) => (
                <div
                  key={idx}
                  className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 flex items-center gap-3"
                >
                  <span className="text-2xl">{badge.icon}</span>
                  <span className={`font-bold ${badge.color}`}>{badge.name}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Jobs */}
          <div>
            <h3 className="font-bold mb-3">Recent Verified Jobs</h3>
            <div className="space-y-3">
              {profile.recentJobs.map((job) => (
                <div
                  key={job.id}
                  className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg overflow-hidden"
                >
                  <div className="flex gap-3 p-3">
                    {/* Thumbnail */}
                    <div className="w-20 h-20 bg-[#252525] rounded overflow-hidden flex-shrink-0">
                      <img
                        src={job.image}
                        alt={job.site}
                        className="w-full h-full object-cover"
                      />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <h4 className="font-bold truncate">{job.site}</h4>
                        <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0" />
                      </div>
                      <p className="text-sm text-gray-400 mb-2">
                        {new Date(job.date).toLocaleDateString()}
                      </p>
                      <div className="flex items-baseline gap-1">
                        <DollarSign className="w-4 h-4 text-[#c5ff3d]" />
                        <span className="text-xl font-bold text-[#c5ff3d]">{job.earned}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
