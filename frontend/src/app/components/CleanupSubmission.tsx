import { useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, Upload, MapPin, CheckCircle, Clock, Loader, Play } from "lucide-react";

type VerificationStatus = "idle" | "submitted" | "reviewing" | "approved" | "paid";

export function CleanupSubmission() {
  const [beforeImage, setBeforeImage] = useState<string | null>(null);
  const [afterImage, setAfterImage] = useState<string | null>(null);
  const [videoEvidence, setVideoEvidence] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<string>("0:00");
  const [receiptImage, setReceiptImage] = useState<string | null>(null);
  const [status, setStatus] = useState<VerificationStatus>("idle");
  const [gpsLocked, setGpsLocked] = useState(true);

  const handleFileUpload = (
    setter: (value: string | null) => void,
    defaultImage: string,
    isVideo?: boolean
  ) => {
    setter(defaultImage);
    if (isVideo) {
      setVideoDuration("1:42");
    }
  };

  const handleSubmit = () => {
    setStatus("submitted");
    setTimeout(() => setStatus("reviewing"), 1500);
    setTimeout(() => setStatus("approved"), 3500);
    setTimeout(() => setStatus("paid"), 5000);
  };

  const getStatusInfo = () => {
    switch (status) {
      case "submitted":
        return { icon: Clock, text: "Submitted", color: "text-blue-400" };
      case "reviewing":
        return { icon: Loader, text: "AI Review", color: "text-yellow-400" };
      case "approved":
        return { icon: CheckCircle, text: "Approved", color: "text-green-400" };
      case "paid":
        return { icon: CheckCircle, text: "Paid", color: "text-[#c5ff3d]" };
      default:
        return null;
    }
  };

  const statusInfo = getStatusInfo();

  return (
    <div className="h-full flex flex-col bg-[#0a0a0a]">
      {/* Header */}
      <div className="bg-black border-b border-[#2a2a2a] p-4 flex items-center gap-3">
        <Link to="/" className="hover:text-[#c5ff3d] transition-colors">
          <ArrowLeft className="w-6 h-6" />
        </Link>
        <h1 className="text-lg font-bold">Submit Cleanup</h1>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* GPS Lock Status */}
        <div
          className={`border rounded-lg p-3 flex items-center gap-3 ${
            gpsLocked
              ? "bg-green-900/20 border-green-700"
              : "bg-red-900/20 border-red-700"
          }`}
        >
          <MapPin className={`w-5 h-5 ${gpsLocked ? "text-green-400" : "text-red-400"}`} />
          <div>
            <p className="font-bold text-sm">
              {gpsLocked ? "GPS Location Confirmed" : "Acquiring GPS..."}
            </p>
            {gpsLocked && (
              <p className="text-xs text-gray-400">40.7128° N, 74.0060° W</p>
            )}
          </div>
        </div>

        {/* Before/After Media */}
        <div>
          <h2 className="font-bold mb-3">Evidence Media</h2>
          <div className="grid grid-cols-3 gap-3">
            {/* Before */}
            <div className="space-y-2">
              <label className="block text-sm text-gray-400">Before</label>
              <div
                className="aspect-[3/4] border-2 border-dashed border-[#2a2a2a] rounded-lg flex items-center justify-center bg-[#1a1a1a] hover:border-[#c5ff3d] transition-colors cursor-pointer overflow-hidden"
                onClick={() =>
                  handleFileUpload(
                    setBeforeImage,
                    "https://images.unsplash.com/photo-1611284446314-60a58ac0deb9?w=400&h=600&fit=crop"
                  )
                }
              >
                {beforeImage ? (
                  <img src={beforeImage} alt="Before" className="w-full h-full object-cover" />
                ) : (
                  <Upload className="w-8 h-8 text-gray-600" />
                )}
              </div>
            </div>

            {/* After */}
            <div className="space-y-2">
              <label className="block text-sm text-gray-400">After</label>
              <div
                className="aspect-[3/4] border-2 border-dashed border-[#2a2a2a] rounded-lg flex items-center justify-center bg-[#1a1a1a] hover:border-[#c5ff3d] transition-colors cursor-pointer overflow-hidden"
                onClick={() =>
                  handleFileUpload(
                    setAfterImage,
                    "https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?w=400&h=600&fit=crop"
                  )
                }
              >
                {afterImage ? (
                  <img src={afterImage} alt="After" className="w-full h-full object-cover" />
                ) : (
                  <Upload className="w-8 h-8 text-gray-600" />
                )}
              </div>
            </div>

            {/* Video Evidence */}
            <div className="space-y-2">
              <label className="block text-sm text-gray-400">Video</label>
              <div
                className="aspect-[3/4] border-2 border-dashed border-[#2a2a2a] rounded-lg flex items-center justify-center bg-[#1a1a1a] hover:border-[#c5ff3d] transition-colors cursor-pointer overflow-hidden relative"
                onClick={() =>
                  handleFileUpload(
                    setVideoEvidence,
                    "https://images.unsplash.com/photo-1618477388954-7852f32655ec?w=400&h=600&fit=crop",
                    true
                  )
                }
              >
                {videoEvidence ? (
                  <>
                    <img src={videoEvidence} alt="Video" className="w-full h-full object-cover" />
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                      <div className="w-12 h-12 rounded-full bg-[#c5ff3d] flex items-center justify-center">
                        <Play className="w-6 h-6 text-black fill-black ml-1" />
                      </div>
                    </div>
                    <div className="absolute bottom-2 right-2 bg-black/80 px-2 py-1 rounded text-xs font-bold">
                      {videoDuration}
                    </div>
                  </>
                ) : (
                  <div className="text-center">
                    <Upload className="w-8 h-8 text-gray-600 mx-auto mb-1" />
                    <p className="text-xs text-gray-600">Optional</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Disposal Receipt */}
        <div>
          <h2 className="font-bold mb-3">Disposal Receipt</h2>
          <div
            className="aspect-video border-2 border-dashed border-[#2a2a2a] rounded-lg flex items-center justify-center bg-[#1a1a1a] hover:border-[#c5ff3d] transition-colors cursor-pointer overflow-hidden"
            onClick={() =>
              handleFileUpload(
                setReceiptImage,
                "https://images.unsplash.com/photo-1554224311-beee4c843053?w=800&h=500&fit=crop"
              )
            }
          >
            {receiptImage ? (
              <img src={receiptImage} alt="Receipt" className="w-full h-full object-cover" />
            ) : (
              <div className="text-center">
                <Upload className="w-8 h-8 text-gray-600 mx-auto mb-2" />
                <p className="text-sm text-gray-400">Upload disposal receipt</p>
              </div>
            )}
          </div>
        </div>

        {/* Verification Status */}
        {status !== "idle" && statusInfo && (
          <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-4">
            <h2 className="font-bold mb-3">Verification Status</h2>
            <div className="space-y-3">
              {["submitted", "reviewing", "approved", "paid"].map((step, idx) => {
                const isActive = status === step;
                const isComplete =
                  ["submitted", "reviewing", "approved", "paid"].indexOf(status) > idx;
                const Icon =
                  step === "submitted"
                    ? Clock
                    : step === "reviewing"
                    ? Loader
                    : CheckCircle;

                return (
                  <div key={step} className="flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center border-2 ${
                        isActive || isComplete
                          ? "border-[#c5ff3d] bg-[#c5ff3d]/20"
                          : "border-[#2a2a2a] bg-[#1a1a1a]"
                      }`}
                    >
                      <Icon
                        className={`w-4 h-4 ${
                          isActive || isComplete ? "text-[#c5ff3d]" : "text-gray-600"
                        } ${isActive && step === "reviewing" ? "animate-spin" : ""}`}
                      />
                    </div>
                    <p
                      className={`font-bold ${
                        isActive || isComplete ? "text-white" : "text-gray-600"
                      }`}
                    >
                      {step === "submitted"
                        ? "Submitted"
                        : step === "reviewing"
                        ? "AI Review"
                        : step === "approved"
                        ? "Approved"
                        : "Paid"}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Submit Button */}
        <button
          onClick={handleSubmit}
          disabled={!beforeImage || !afterImage || !receiptImage || status !== "idle"}
          className="w-full bg-[#c5ff3d] text-black py-4 rounded-lg font-bold hover:bg-[#d4ff5d] transition-colors disabled:bg-[#2a2a2a] disabled:text-gray-600 disabled:cursor-not-allowed"
        >
          {status === "idle" ? "Submit for AI Verification" : "Verification in Progress..."}
        </button>
      </div>
    </div>
  );
}
