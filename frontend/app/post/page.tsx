"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import BountyMapClient from "../_components/BountyMapClient";
import { ScreenHeader } from "../_components/ScreenHeader";
import { Button } from "../_components/Button";
import { Card } from "../_components/Card";
import { Badge } from "../_components/Badge";
import { VideoPlaceholder } from "../_components/VideoPlaceholder";
import {
  ArrowRightIcon,
  CameraIcon,
  CheckIcon,
  CoinIcon,
  CompassIcon,
  CrosshairIcon,
  LeafIcon,
  LocationIcon,
} from "../_components/icons";
import { useGeolocation } from "../../lib/useGeolocation";
import { DEFAULT_LOCATION } from "../../lib/mock-data";
import { postBounty } from "../../lib/api";
import type { Bounty, BountyCategory } from "../../lib/types";
import { useToast } from "../_components/Toast";
import { categoryLabel, formatUsd } from "../../lib/format";

type Step = 1 | 2 | 3 | 4;

const CATEGORIES: { id: BountyCategory; emoji: string; label: string }[] = [
  { id: "litter", emoji: "🧴", label: "Litter" },
  { id: "graffiti", emoji: "🎨", label: "Graffiti" },
  { id: "illegal_dumping", emoji: "🚮", label: "Dumping" },
  { id: "park", emoji: "🌳", label: "Park" },
  { id: "beach", emoji: "🏖️", label: "Beach" },
  { id: "other", emoji: "✨", label: "Other" },
];

const REWARD_QUICK = [0.05, 0.1, 0.2, 0.35, 0.5];

export default function PostBountyPage() {
  const router = useRouter();
  const geo = useGeolocation();
  const { toast } = useToast();
  const [step, setStep] = useState<Step>(1);
  const [pinPos, setPinPos] = useState(DEFAULT_LOCATION);
  const [mapCenter, setMapCenter] = useState(DEFAULT_LOCATION);
  const [category, setCategory] = useState<BountyCategory>("litter");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [reward, setReward] = useState<string>("0.20");
  const [referenceCaptured, setReferenceCaptured] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<Bounty | null>(null);

  useEffect(() => {
    if (geo.location) {
      setPinPos(geo.location);
      setMapCenter(geo.location);
    }
  }, [geo.location]);

  const rewardNum = parseFloat(reward);
  const usdEstimate = isFinite(rewardNum) ? Math.round(rewardNum * 153) : 0;

  const canNext = useMemo(() => {
    if (step === 1) return true;
    if (step === 2)
      return title.trim().length >= 4 && description.trim().length >= 8 && rewardNum > 0;
    if (step === 3) return referenceCaptured;
    return true;
  }, [step, title, description, rewardNum, referenceCaptured]);

  const onSubmit = async () => {
    setSubmitting(true);
    try {
      const b = await postBounty({
        title: title.trim(),
        description: description.trim(),
        lat: pinPos.lat,
        lng: pinPos.lng,
        address: "Pinned location",
        reward_sol: rewardNum,
        category,
        reference_video_url: null,
        reference_thumbnail_url: null,
      });
      setCreated(b);
      toast(`${rewardNum.toFixed(2)} SOL escrowed`, {
        variant: "success",
        description: "Your bounty is live on the map.",
      });
    } catch {
      toast("Couldn't post bounty", { variant: "error" });
    } finally {
      setSubmitting(false);
    }
  };

  if (created) {
    return <PostedSuccess bounty={created} onDone={() => router.replace("/")} />;
  }

  return (
    <div className="flex-1 flex flex-col">
      <ScreenHeader
        title="New bounty"
        subtitle={`Step ${step} of 4`}
        right={
          <button
            onClick={() => router.replace("/")}
            className="text-sm text-[color:var(--color-muted)] px-2 py-1"
          >
            Save & exit
          </button>
        }
      />

      <Stepper step={step} />

      <div className="flex-1 flex flex-col">
        {step === 1 && (
          <StepLocation
            pinPos={pinPos}
            mapCenter={mapCenter}
            onPinMove={setPinPos}
            onMapMove={(c) => setMapCenter(c)}
            userLocation={geo.location}
            onRecenter={() => geo.location && setMapCenter(geo.location)}
          />
        )}
        {step === 2 && (
          <StepDetails
            category={category}
            setCategory={setCategory}
            title={title}
            setTitle={setTitle}
            description={description}
            setDescription={setDescription}
            reward={reward}
            setReward={setReward}
            usdEstimate={usdEstimate}
          />
        )}
        {step === 3 && (
          <StepReference
            captured={referenceCaptured}
            onCapture={() => setReferenceCaptured(true)}
            category={category}
          />
        )}
        {step === 4 && (
          <StepReview
            title={title}
            description={description}
            reward={rewardNum}
            usdEstimate={usdEstimate}
            category={category}
            pinPos={pinPos}
          />
        )}
      </div>

      <div
        className="sticky bottom-0 bg-white/95 backdrop-blur border-t border-[color:var(--color-border)] px-4 pt-3 z-30"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
      >
        <div className="flex gap-2">
          {step > 1 && (
            <Button
              variant="secondary"
              size="xl"
              onClick={() => setStep(((step - 1) as Step))}
            >
              Back
            </Button>
          )}
          {step < 4 ? (
            <Button
              fullWidth
              size="xl"
              disabled={!canNext}
              iconRight={<ArrowRightIcon width={18} height={18} />}
              onClick={() => setStep((step + 1) as Step)}
            >
              Continue
            </Button>
          ) : (
            <Button
              fullWidth
              size="xl"
              loading={submitting}
              iconRight={<CheckIcon width={18} height={18} />}
              onClick={onSubmit}
            >
              Escrow {rewardNum.toFixed(2)} SOL & post
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  return (
    <div className="px-4 pt-2">
      <div className="flex items-center gap-1.5">
        {[1, 2, 3, 4].map((n) => (
          <span
            key={n}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              n <= step
                ? "bg-[color:var(--color-brand-500)]"
                : "bg-[color:var(--color-surface-2)]"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function StepLocation({
  pinPos,
  mapCenter,
  onPinMove,
  onMapMove,
  userLocation,
  onRecenter,
}: {
  pinPos: { lat: number; lng: number };
  mapCenter: { lat: number; lng: number };
  onPinMove: (p: { lat: number; lng: number }) => void;
  onMapMove: (p: { lat: number; lng: number }) => void;
  userLocation: { lat: number; lng: number } | null;
  onRecenter: () => void;
}) {
  return (
    <div className="flex-1 flex flex-col">
      <div className="px-4 pt-3 pb-2">
        <h2 className="text-[22px] font-semibold tracking-tight leading-tight">
          Where is the work?
        </h2>
        <p className="text-sm text-[color:var(--color-muted)] mt-1">
          Drag the pin, or pan the map and tap{" "}
          <span className="font-medium text-[color:var(--color-ink)]">
            Drop pin here
          </span>
          . We&rsquo;ll geofence it within ~25 m for verification.
        </p>
      </div>
      <div className="relative flex-1 min-h-[360px] mx-4 mb-3 rounded-[20px] overflow-hidden border border-[color:var(--color-border)] bg-[#eef2ee]">
        <div className="absolute inset-0">
          <BountyMapClient
            bounties={[]}
            center={mapCenter}
            userLocation={userLocation}
            onPinTap={() => {}}
            draggable
            pinPosition={pinPos}
            onPinMove={onPinMove}
            onMapMove={onMapMove}
          />
        </div>

        {/* Subtle center crosshair so the user can see where "Drop pin here" will land */}
        <div className="pointer-events-none absolute inset-0 grid place-items-center z-[1]">
          <span className="grid place-items-center w-7 h-7 rounded-full bg-white/85 ring-2 ring-[color:var(--color-brand-500)] text-[color:var(--color-brand-600)] shadow-[var(--shadow-card)]">
            <CrosshairIcon width={14} height={14} />
          </span>
        </div>

        {/* Coord pill (top-left) */}
        <div className="absolute left-3 top-3 z-[2] px-2.5 py-1 rounded-full bg-white/95 backdrop-blur shadow-[var(--shadow-card)] border border-[color:var(--color-border)] flex items-center gap-1.5 text-[11px] tabular text-[color:var(--color-muted)]">
          <CompassIcon width={12} height={12} />
          {pinPos.lat.toFixed(5)}, {pinPos.lng.toFixed(5)}
        </div>

        {/* Drop-pin CTA (bottom-center) */}
        <button
          onClick={() => onPinMove(mapCenter)}
          className="absolute left-1/2 -translate-x-1/2 bottom-3 z-[2] px-3.5 py-2 rounded-full bg-white text-[12px] font-medium shadow-[var(--shadow-card)] border border-[color:var(--color-border)] flex items-center gap-1.5 active:scale-[0.98] transition-transform"
        >
          <LocationIcon width={14} height={14} />
          Drop pin here
        </button>

        {/* Recenter (bottom-right) */}
        <button
          onClick={onRecenter}
          aria-label="Recenter on me"
          className="absolute right-3 bottom-3 z-[2] grid place-items-center w-10 h-10 rounded-full bg-white shadow-[var(--shadow-card)] border border-[color:var(--color-border)] active:scale-95 transition-transform"
        >
          <CrosshairIcon width={18} height={18} />
        </button>
      </div>
    </div>
  );
}

function StepDetails({
  category,
  setCategory,
  title,
  setTitle,
  description,
  setDescription,
  reward,
  setReward,
  usdEstimate,
}: {
  category: BountyCategory;
  setCategory: (c: BountyCategory) => void;
  title: string;
  setTitle: (s: string) => void;
  description: string;
  setDescription: (s: string) => void;
  reward: string;
  setReward: (s: string) => void;
  usdEstimate: number;
}) {
  return (
    <div className="flex-1 px-4 pt-3 pb-6 space-y-5">
      <div>
        <h2 className="text-[22px] font-semibold tracking-tight leading-tight">
          What needs doing?
        </h2>
        <p className="text-sm text-[color:var(--color-muted)] mt-1">
          A clear description helps the right person claim it.
        </p>
      </div>

      <FieldGroup label="Category">
        <div className="grid grid-cols-3 gap-2">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              className={`flex flex-col items-center justify-center gap-1 py-3 rounded-[14px] border transition-colors ${
                category === c.id
                  ? "border-[color:var(--color-brand-500)] bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-700)]"
                  : "border-[color:var(--color-border)] hover:bg-[color:var(--color-surface)]"
              }`}
            >
              <span className="text-[22px] leading-none">{c.emoji}</span>
              <span className="text-[12px] font-medium">{c.label}</span>
            </button>
          ))}
        </div>
      </FieldGroup>

      <FieldGroup label="Title" hint={`${title.length}/60`}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value.slice(0, 60))}
          placeholder="e.g. Bags of trash behind bus stop"
          className="w-full h-12 px-4 bg-[color:var(--color-surface)] rounded-[12px] text-[15px] outline-none focus:bg-white focus:ring-2 focus:ring-[color:var(--color-brand-500)] transition-all"
        />
      </FieldGroup>

      <FieldGroup label="Description" hint={`${description.length}/280`}>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, 280))}
          placeholder="What's there, where exactly, anything they should bring?"
          rows={4}
          className="w-full px-4 py-3 bg-[color:var(--color-surface)] rounded-[12px] text-[15px] outline-none focus:bg-white focus:ring-2 focus:ring-[color:var(--color-brand-500)] transition-all resize-none"
        />
      </FieldGroup>

      <FieldGroup label="Reward" hint={`~${formatUsd(usdEstimate)}`}>
        <div className="relative">
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={reward}
            onChange={(e) => setReward(e.target.value)}
            className="w-full h-14 pl-12 pr-16 bg-[color:var(--color-surface)] rounded-[14px] text-[22px] font-semibold tabular outline-none focus:bg-white focus:ring-2 focus:ring-[color:var(--color-brand-500)] transition-all"
          />
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[color:var(--color-brand-600)]">
            <CoinIcon width={20} height={20} />
          </span>
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-semibold text-[color:var(--color-muted)]">
            SOL
          </span>
        </div>
        <div className="flex gap-1.5 mt-2 overflow-x-auto scroll-clean">
          {REWARD_QUICK.map((q) => (
            <button
              key={q}
              onClick={() => setReward(q.toFixed(2))}
              className="px-3 h-8 text-xs font-medium rounded-full border border-[color:var(--color-border)] bg-white hover:bg-[color:var(--color-surface)] tabular shrink-0"
            >
              {q.toFixed(2)} SOL
            </button>
          ))}
        </div>
      </FieldGroup>
    </div>
  );
}

function StepReference({
  captured,
  onCapture,
  category,
}: {
  captured: boolean;
  onCapture: () => void;
  category: BountyCategory;
}) {
  return (
    <div className="flex-1 px-4 pt-3 pb-6 space-y-5">
      <div>
        <h2 className="text-[22px] font-semibold tracking-tight leading-tight">
          Record a reference video
        </h2>
        <p className="text-sm text-[color:var(--color-muted)] mt-1">
          Pan slowly for ~10 seconds at the location. Claimers will use this to match framing.
        </p>
      </div>

      <Card className="p-3">
        {captured ? (
          <VideoPlaceholder category={category} aspect="aspect-[16/10]" label="Your reference" />
        ) : (
          <div className="aspect-[16/10] rounded-[14px] bg-[color:var(--color-surface)] grid place-items-center text-[color:var(--color-muted)] text-sm">
            <div className="text-center">
              <CameraIcon width={28} height={28} />
              <p className="mt-2">No video yet</p>
            </div>
          </div>
        )}
        <div className="px-1 pt-3 flex items-center justify-between">
          <p className="text-xs text-[color:var(--color-muted)]">
            Recommended: 10–15 seconds, full sweep of the spot.
          </p>
          <Button
            size="sm"
            variant={captured ? "secondary" : "primary"}
            onClick={onCapture}
            iconLeft={<CameraIcon width={16} height={16} />}
          >
            {captured ? "Re-record" : "Record"}
          </Button>
        </div>
      </Card>

      <Card className="p-4">
        <p className="text-sm font-semibold tracking-tight">Why we need this</p>
        <ul className="mt-2 grid gap-2">
          <Hint>The claimer&rsquo;s after-video must structurally match this scene.</Hint>
          <Hint>The reference is private to verifying claimers and our AI checks.</Hint>
          <Hint>Cleanr only releases payment when before/after match a real change.</Hint>
        </ul>
      </Card>
    </div>
  );
}

function StepReview({
  title,
  description,
  reward,
  usdEstimate,
  category,
  pinPos,
}: {
  title: string;
  description: string;
  reward: number;
  usdEstimate: number;
  category: BountyCategory;
  pinPos: { lat: number; lng: number };
}) {
  return (
    <div className="flex-1 px-4 pt-3 pb-6 space-y-4">
      <div>
        <h2 className="text-[22px] font-semibold tracking-tight leading-tight">
          Review &amp; escrow
        </h2>
        <p className="text-sm text-[color:var(--color-muted)] mt-1">
          Funds stay in the smart contract until verification passes. You can cancel any time before claim.
        </p>
      </div>

      <Card className="p-4">
        <Badge tone="muted" size="sm">{categoryLabel(category)}</Badge>
        <h3 className="text-[18px] font-semibold tracking-tight mt-2 leading-snug">
          {title || "Untitled bounty"}
        </h3>
        <p className="text-sm text-[color:var(--color-ink-2)] mt-1.5 leading-relaxed">
          {description || "—"}
        </p>
        <div className="mt-3 flex items-center justify-between border-t border-[color:var(--color-border)] pt-3">
          <span className="text-xs text-[color:var(--color-muted)] tabular">
            {pinPos.lat.toFixed(5)}, {pinPos.lng.toFixed(5)}
          </span>
          <span className="text-[18px] font-bold tabular text-[color:var(--color-brand-600)] flex items-center gap-1">
            <CoinIcon width={16} height={16} /> {reward.toFixed(2)} SOL
          </span>
        </div>
      </Card>

      <Card className="p-4 grid gap-2">
        <Row label="Network fee" value="~$0.001" />
        <Row label="Verification" value="AI + sensor multi-check" />
        <Row label="Auto-refund" value="Bounty refunds if unclaimed in 7d" />
        <div className="border-t border-[color:var(--color-border)] mt-1" />
        <Row label="Total escrow" value={`${reward.toFixed(2)} SOL · ~${formatUsd(usdEstimate)}`} bold />
      </Card>
    </div>
  );
}

function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-[12px] uppercase tracking-wider text-[color:var(--color-muted)] font-semibold">
          {label}
        </label>
        {hint && (
          <span className="text-[11px] text-[color:var(--color-muted)] tabular">
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className="mt-1.5 inline-block w-1.5 h-1.5 rounded-full bg-[color:var(--color-brand-500)]" />
      <span className="text-[color:var(--color-ink-2)] leading-snug">{children}</span>
    </li>
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-[color:var(--color-muted)]">{label}</span>
      <span className={`tabular ${bold ? "font-bold text-[color:var(--color-ink)]" : "text-[color:var(--color-ink-2)]"}`}>
        {value}
      </span>
    </div>
  );
}

function PostedSuccess({
  bounty,
  onDone,
}: {
  bounty: Bounty;
  onDone: () => void;
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
      <span className="grid place-items-center w-20 h-20 rounded-full bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-600)]">
        <LeafIcon width={32} height={32} />
      </span>
      <h2 className="text-[24px] font-semibold tracking-tight mt-5">
        Your bounty is live
      </h2>
      <p className="text-sm text-[color:var(--color-muted)] mt-2 max-w-[280px]">
        {bounty.reward_sol.toFixed(2)} SOL is escrowed. The claimer pool is being notified.
      </p>
      <div className="mt-6 w-full max-w-[320px] grid gap-2">
        <Button fullWidth size="xl" onClick={onDone}>
          Back to map
        </Button>
      </div>
    </div>
  );
}
