"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import BountyMapClient from "../_components/BountyMapClient";
import { ScreenHeader } from "../_components/ScreenHeader";
import { Button } from "../_components/Button";
import { Card } from "../_components/Card";
import { Badge } from "../_components/Badge";
import { CameraCapture } from "../_components/CameraCapture";
import {
  ArrowRightIcon,
  CameraIcon,
  CheckIcon,
  CoinIcon,
  CompassIcon,
  CrosshairIcon,
  FireIcon,
  LeafIcon,
  LocationIcon,
  WorldcoinIcon,
} from "../_components/icons";
import { useGeolocation } from "../../lib/useGeolocation";
import { DEFAULT_LOCATION } from "../../lib/mock-data";
import { getMe, postBounty, uploadFixtureVideo } from "../../lib/api";
import type { Bounty, BountyCategory, RewardType } from "../../lib/types";
import { useToast } from "../_components/Toast";
import {
  categoryLabel,
  formatUsd,
  formatReward,
  formatWld,
  formatXp,
} from "../../lib/format";

type Step = 1 | 2 | 3 | 4;

const CATEGORIES: { id: BountyCategory; emoji: string; label: string }[] = [
  { id: "litter", emoji: "🧴", label: "Litter" },
  { id: "illegal_dumping", emoji: "🚮", label: "Dumping" },
  { id: "park", emoji: "🌳", label: "Park" },
  { id: "beach", emoji: "🏖️", label: "Beach" },
  { id: "other", emoji: "✨", label: "Other" },
];

const REWARD_QUICK = [0.05, 0.1, 0.2, 0.35, 0.5];
const XP_QUICK = [25, 50, 100, 200, 500];
const WLD_QUICK = [0.1, 0.5, 1, 2, 5];
const MIN_XP_STAKE = 5;
const MAX_XP_STAKE = 5000;
// Mirror MIN_WLD_REWARD / MAX_WLD_REWARD on the backend; if you change one,
// change the other in lockstep.
const MIN_WLD_REWARD = 0.01;
const MAX_WLD_REWARD = 50;

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
  const [rewardType, setRewardType] = useState<RewardType>("sol");
  const [reward, setReward] = useState<string>("0.20");
  const [xpStake, setXpStake] = useState<string>("100");
  const [wldStake, setWldStake] = useState<string>("1.00");
  const [userXpBalance, setUserXpBalance] = useState<number | null>(null);
  const [insideWorldApp, setInsideWorldApp] = useState<boolean>(false);
  const [referenceBlob, setReferenceBlob] = useState<Blob | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<Bounty | null>(null);
  const [mapRecenterTick, setMapRecenterTick] = useState(0);
  // Stable nonce used as a watermark while recording the reference video.
  // Derived once per page mount so retakes don't change it.
  const noncesRef = useRef<string | null>(null);
  if (noncesRef.current === null) {
    noncesRef.current = Math.random().toString(36).slice(2, 10).toUpperCase();
  }

  useEffect(() => {
    if (geo.location) {
      setPinPos(geo.location);
      setMapCenter(geo.location);
    }
  }, [geo.location]);

  const rewardNum = parseFloat(reward);
  const xpNum = Math.round(parseFloat(xpStake));
  const wldNum = parseFloat(wldStake);
  const usdEstimate = isFinite(rewardNum) ? Math.round(rewardNum * 153) : 0;
  // Rough WLD->USD; matches WLD_USD_RATE in lib/api.ts. Used for UX hints
  // only, not for any value transfer.
  const wldUsdEstimate = isFinite(wldNum) ? Math.round(wldNum * 2.5) : 0;
  const solRewardOk = rewardType === "sol" && rewardNum > 0;
  const xpStakeOk =
    rewardType === "xp" &&
    Number.isFinite(xpNum) &&
    xpNum >= MIN_XP_STAKE &&
    xpNum <= MAX_XP_STAKE;
  const wldStakeOk =
    rewardType === "wld" &&
    Number.isFinite(wldNum) &&
    wldNum >= MIN_WLD_REWARD &&
    wldNum <= MAX_WLD_REWARD;

  useEffect(() => {
    getMe()
      .then((u) => setUserXpBalance(u.xp))
      .catch(() => setUserXpBalance(null));
  }, []);

  // Detect MiniKit on mount so we can disable the WLD tab outside World App
  // and keep the user from getting deep into the flow before discovering
  // they need to switch contexts. The dynamic import keeps SSR safe.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mod = await import("../../lib/world");
        if (cancelled) return;
        const inside = await mod.isInsideWorldApp();
        setInsideWorldApp(inside);
        // Best-effort wallet sync so /api/users/me has the recipient address
        // on file before the user posts (also helps when they later claim).
        if (inside) await mod.syncWorldWalletAddress();
      } catch {
        if (!cancelled) setInsideWorldApp(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const canNext = useMemo(() => {
    if (step === 1) return true;
    if (step === 2) {
      const base =
        title.trim().length >= 4 &&
        description.trim().length >= 8;
      if (rewardType === "sol") return base && solRewardOk;
      if (rewardType === "wld") return base && wldStakeOk && insideWorldApp;
      return base && xpStakeOk;
    }
    if (step === 3) return referenceBlob !== null;
    return true;
  }, [
    step,
    title,
    description,
    referenceBlob,
    rewardType,
    solRewardOk,
    xpStakeOk,
    wldStakeOk,
    insideWorldApp,
  ]);

  const onSubmit = async () => {
    if (!referenceBlob) {
      toast("Reference video is missing", {
        variant: "error",
        description: "Go back to step 3 and record the spot.",
      });
      return;
    }

    setSubmitting(true);
    try {
      // Upload the recorded reference clip to the AI service first so Stage 1
      // has the right ground truth for any future verification of this bounty.
      // We block on it: posting the bounty without a synced reference would
      // leave Stage 1 reading a stale fixture from a previous session.
      await uploadFixtureVideo(referenceBlob, "request");

      const common = {
        title: title.trim(),
        description: description.trim(),
        lat: pinPos.lat,
        lng: pinPos.lng,
        address: "Pinned location",
        category,
        reference_video_url: null,
        reference_thumbnail_url: null,
      } as const;

      // The WLD branch detours through MiniKit *inside* `postBounty()` so
      // we don't need to thread the SDK call through this component. If
      // we're not inside World App, postBounty surfaces a typed error we
      // can map to a friendly toast below.
      const result = await postBounty(
        rewardType === "sol"
          ? {
              ...common,
              reward_type: "sol" as const,
              reward_sol: rewardNum,
            }
          : rewardType === "wld"
            ? {
                ...common,
                reward_type: "wld" as const,
                reward_wld: wldNum,
              }
            : {
                ...common,
                reward_type: "xp" as const,
                reward_xp: xpNum,
              }
      );
      setCreated(result.bounty);
      if (result.bounty.reward_type === "xp") {
        toast(`${formatReward(result.bounty)} staked from your balance`, {
          variant: "success",
          description: "Your XP bounty is live on the map.",
        });
      } else if (result.bounty.reward_type === "wld") {
        toast(`${formatWld(wldNum)} escrowed via World App`, {
          variant: "success",
          description: result.world_pay_tx_hash
            ? `Tx ${result.world_pay_tx_hash.slice(0, 10)}…`
            : "Your bounty is live on the map.",
        });
      } else {
        toast(`${rewardNum.toFixed(2)} SOL escrowed`, {
          variant: "success",
          description: "Your bounty is live on the map.",
        });
      }
      getMe()
        .then((u) => setUserXpBalance(u.xp))
        .catch(() => {});
    } catch (err) {
      // Map the typed errors from `lib/world.ts` to user-friendly copy.
      // The class names are checked by string so we don't have to import
      // the class in this server-component-eligible file.
      const errName =
        err instanceof Error
          ? (err as { name?: string }).name ?? ""
          : "";
      if (errName === "OutsideWorldAppError") {
        toast("Open this page inside World App", {
          variant: "error",
          description:
            "WLD bounties require signing inside World App. SOL or XP work in any browser.",
        });
      } else if (errName === "WorldPayUserCancelledError") {
        toast("Payment cancelled", {
          variant: "info",
          description: "No bounty was created. You can try again.",
        });
      } else {
        toast("Couldn't post bounty", {
          variant: "error",
          description: err instanceof Error ? err.message : undefined,
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (created) {
    return <PostedSuccess bounty={created} onDone={() => router.replace("/")} />;
  }

  return (
    <div className="flex-1 flex flex-col">
      {cameraOpen && (
        <CameraCapture
          nonce={noncesRef.current!}
          category={category}
          submitLabel="Use this recording"
          submittingLabel="Saving…"
          hint="Pan slowly across the spot — this becomes the ground truth"
          onCancel={() => setCameraOpen(false)}
          onSubmit={(blob) => {
            setReferenceBlob(blob);
            setCameraOpen(false);
          }}
        />
      )}
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
            mapRecenterTick={mapRecenterTick}
            onPinMove={setPinPos}
            onMapMove={(c) => setMapCenter(c)}
            userLocation={geo.location}
            onRecenter={() => {
              if (typeof window === "undefined") return;
              if (!("geolocation" in navigator)) {
                if (geo.location) {
                  setMapCenter({ ...geo.location });
                  setMapRecenterTick((t) => t + 1);
                }
                return;
              }
              navigator.geolocation.getCurrentPosition(
                (pos) => {
                  const next = {
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                  };
                  setMapCenter(next);
                  setMapRecenterTick((t) => t + 1);
                },
                () => {
                  if (geo.location) {
                    setMapCenter({ ...geo.location });
                    setMapRecenterTick((t) => t + 1);
                  }
                },
                { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
              );
            }}
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
            rewardType={rewardType}
            setRewardType={setRewardType}
            reward={reward}
            setReward={setReward}
            xpStake={xpStake}
            setXpStake={setXpStake}
            wldStake={wldStake}
            setWldStake={setWldStake}
            usdEstimate={usdEstimate}
            wldUsdEstimate={wldUsdEstimate}
            userXpBalance={userXpBalance}
            insideWorldApp={insideWorldApp}
          />
        )}
        {step === 3 && (
          <StepReference
            referenceBlob={referenceBlob}
            onOpenCamera={() => setCameraOpen(true)}
            category={category}
          />
        )}
        {step === 4 && (
          <StepReview
            title={title}
            description={description}
            rewardType={rewardType}
            rewardSol={rewardNum}
            rewardXp={xpNum}
            rewardWld={wldNum}
            usdEstimate={usdEstimate}
            wldUsdEstimate={wldUsdEstimate}
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
              {rewardType === "sol"
                ? `Escrow ${rewardNum.toFixed(2)} SOL & post`
                : rewardType === "wld"
                  ? `Pay ${formatWld(wldNum)} via World App & post`
                  : `Stake ${formatXp(xpNum)} & post`}
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
  mapRecenterTick,
  onPinMove,
  onMapMove,
  userLocation,
  onRecenter,
}: {
  pinPos: { lat: number; lng: number };
  mapCenter: { lat: number; lng: number };
  mapRecenterTick: number;
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
            recenterTick={mapRecenterTick}
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
  rewardType,
  setRewardType,
  reward,
  setReward,
  xpStake,
  setXpStake,
  wldStake,
  setWldStake,
  usdEstimate,
  wldUsdEstimate,
  userXpBalance,
  insideWorldApp,
}: {
  category: BountyCategory;
  setCategory: (c: BountyCategory) => void;
  title: string;
  setTitle: (s: string) => void;
  description: string;
  setDescription: (s: string) => void;
  rewardType: RewardType;
  setRewardType: (t: RewardType) => void;
  reward: string;
  setReward: (s: string) => void;
  xpStake: string;
  setXpStake: (s: string) => void;
  wldStake: string;
  setWldStake: (s: string) => void;
  usdEstimate: number;
  wldUsdEstimate: number;
  userXpBalance: number | null;
  insideWorldApp: boolean;
}) {
  const xpParsed = Math.round(parseFloat(xpStake));
  const wldParsed = parseFloat(wldStake);
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

      <FieldGroup
        label="Reward type"
        hint={
          rewardType === "sol"
            ? `~${formatUsd(usdEstimate)}`
            : rewardType === "wld"
              ? `~${formatUsd(wldUsdEstimate)}`
              : "No crypto needed"
        }
      >
        <div className="flex gap-1.5 p-1 bg-[color:var(--color-surface)] rounded-full">
          <button
            type="button"
            onClick={() => setRewardType("sol")}
            className={`flex-1 h-10 text-sm font-semibold rounded-full transition-colors ${
              rewardType === "sol"
                ? "bg-white text-[color:var(--color-ink)] shadow-[var(--shadow-card)]"
                : "text-[color:var(--color-muted)]"
            }`}
          >
            Solana
          </button>
          <button
            type="button"
            onClick={() => setRewardType("wld")}
            className={`flex-1 h-10 text-sm font-semibold rounded-full transition-colors ${
              rewardType === "wld"
                ? "bg-white text-[color:var(--color-ink)] shadow-[var(--shadow-card)]"
                : "text-[color:var(--color-muted)]"
            }`}
          >
            WLD
          </button>
          <button
            type="button"
            onClick={() => setRewardType("xp")}
            className={`flex-1 h-10 text-sm font-semibold rounded-full transition-colors ${
              rewardType === "xp"
                ? "bg-white text-[color:var(--color-ink)] shadow-[var(--shadow-card)]"
                : "text-[color:var(--color-muted)]"
            }`}
          >
            XP only
          </button>
        </div>
        {rewardType === "sol" ? (
          <div className="mt-3">
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
            <p className="text-[11px] text-[color:var(--color-muted)] mt-1.5">
              Claimers also earn bonus XP from AI scoring based on the task.
            </p>
            <div className="flex gap-1.5 mt-2 overflow-x-auto scroll-clean">
              {REWARD_QUICK.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => setReward(q.toFixed(2))}
                  className="px-3 h-8 text-xs font-medium rounded-full border border-[color:var(--color-border)] bg-white hover:bg-[color:var(--color-surface)] tabular shrink-0"
                >
                  {q.toFixed(2)} SOL
                </button>
              ))}
            </div>
          </div>
        ) : rewardType === "wld" ? (
          <div className="mt-3">
            <div className="relative">
              <input
                type="number"
                inputMode="decimal"
                min={MIN_WLD_REWARD}
                max={MAX_WLD_REWARD}
                step="0.01"
                value={wldStake}
                onChange={(e) => setWldStake(e.target.value)}
                className="w-full h-14 pl-12 pr-16 bg-[color:var(--color-surface)] rounded-[14px] text-[22px] font-semibold tabular outline-none focus:bg-white focus:ring-2 focus:ring-[color:var(--color-brand-500)] transition-all"
              />
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[color:var(--color-brand-600)]">
                <WorldcoinIcon width={20} height={20} />
              </span>
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-semibold text-[color:var(--color-muted)]">
                WLD
              </span>
            </div>
            {/* Outside-World-App banner. We deliberately leave the input
               * editable so the user can preview the amount, but the
               * Continue button stays disabled until MiniKit is ready. */}
            {!insideWorldApp ? (
              <p className="text-[11px] text-red-600 mt-1.5">
                Open this page inside <span className="font-semibold">World App</span> to escrow WLD. The
                Solana and XP options work in any browser.
              </p>
            ) : (
              <p className="text-[11px] text-[color:var(--color-muted)] mt-1.5">
                You&rsquo;ll sign one payment to the bounty vault inside World App. Refundable if the
                cleanup is rejected.
              </p>
            )}
            <p className="text-[11px] text-[color:var(--color-muted)] mt-1">
              Stake {MIN_WLD_REWARD}–{MAX_WLD_REWARD} WLD. Gas is sponsored by World App for verified
              users.
            </p>
            <div className="flex gap-1.5 mt-2 overflow-x-auto scroll-clean">
              {WLD_QUICK.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => setWldStake(q.toFixed(2))}
                  className="px-3 h-8 text-xs font-medium rounded-full border border-[color:var(--color-border)] bg-white hover:bg-[color:var(--color-surface)] tabular shrink-0"
                >
                  {q < 1 ? q.toFixed(2) : q.toFixed(0)} WLD
                </button>
              ))}
            </div>
            {!Number.isNaN(wldParsed) &&
              (wldParsed < MIN_WLD_REWARD || wldParsed > MAX_WLD_REWARD) && (
                <p className="text-[11px] text-red-600 mt-1">
                  WLD reward must be between {MIN_WLD_REWARD} and {MAX_WLD_REWARD}.
                </p>
              )}
          </div>
        ) : (
          <div className="mt-3">
            <div className="relative">
              <input
                type="number"
                inputMode="numeric"
                min={MIN_XP_STAKE}
                max={MAX_XP_STAKE}
                step="5"
                value={xpStake}
                onChange={(e) => setXpStake(e.target.value)}
                className="w-full h-14 pl-12 pr-20 bg-[color:var(--color-surface)] rounded-[14px] text-[22px] font-semibold tabular outline-none focus:bg-white focus:ring-2 focus:ring-[color:var(--color-brand-500)] transition-all"
              />
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[color:var(--color-brand-600)]">
                <FireIcon width={20} height={20} />
              </span>
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-semibold text-[color:var(--color-muted)]">
                XP
              </span>
            </div>
            {userXpBalance !== null && (
              <p className="text-[11px] text-[color:var(--color-muted)] mt-1.5">
                Your balance: {formatXp(userXpBalance)}
                {userXpBalance < xpParsed && xpParsed >= MIN_XP_STAKE ? (
                  <span className="text-red-600"> · Not enough XP</span>
                ) : null}
              </p>
            )}
            <p className="text-[11px] text-[color:var(--color-muted)] mt-1">
              Stake {MIN_XP_STAKE}–{MAX_XP_STAKE} XP. It is held until the bounty is completed or
              rejected.
            </p>
            <div className="flex gap-1.5 mt-2 overflow-x-auto scroll-clean">
              {XP_QUICK.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => setXpStake(String(q))}
                  className="px-3 h-8 text-xs font-medium rounded-full border border-[color:var(--color-border)] bg-white hover:bg-[color:var(--color-surface)] tabular shrink-0"
                >
                  {q} XP
                </button>
              ))}
            </div>
          </div>
        )}
      </FieldGroup>
    </div>
  );
}

function StepReference({
  referenceBlob,
  onOpenCamera,
  category: _category,
}: {
  referenceBlob: Blob | null;
  onOpenCamera: () => void;
  category: BountyCategory;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!referenceBlob) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(referenceBlob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [referenceBlob]);

  const sizeMb = referenceBlob
    ? (referenceBlob.size / (1024 * 1024)).toFixed(1)
    : null;

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
        {previewUrl ? (
          <video
            src={previewUrl}
            className="w-full aspect-[16/10] rounded-[14px] object-cover bg-black"
            playsInline
            muted
            loop
            autoPlay
            controls
          />
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
            {referenceBlob
              ? `Captured · ${sizeMb} MB. You can re-record if it didn't capture cleanly.`
              : "Recommended: 10–15 seconds, full sweep of the spot."}
          </p>
          <Button
            size="sm"
            variant={referenceBlob ? "secondary" : "primary"}
            onClick={onOpenCamera}
            iconLeft={<CameraIcon width={16} height={16} />}
          >
            {referenceBlob ? "Re-record" : "Record"}
          </Button>
        </div>
      </Card>

      <Card className="p-4">
        <p className="text-sm font-semibold tracking-tight">Why we need this</p>
        <ul className="mt-2 grid gap-2">
          <Hint>The claimer&rsquo;s after-video must structurally match this scene.</Hint>
          <Hint>The reference is private to verifying claimers and our AI checks.</Hint>
          <Hint>EcoBounty only releases payment when before/after match a real change.</Hint>
        </ul>
      </Card>
    </div>
  );
}

function StepReview({
  title,
  description,
  rewardType,
  rewardSol,
  rewardXp,
  rewardWld,
  usdEstimate,
  wldUsdEstimate,
  category,
  pinPos,
}: {
  title: string;
  description: string;
  rewardType: RewardType;
  rewardSol: number;
  rewardXp: number;
  rewardWld: number;
  usdEstimate: number;
  wldUsdEstimate: number;
  category: BountyCategory;
  pinPos: { lat: number; lng: number };
}) {
  const isSol = rewardType === "sol";
  const isWld = rewardType === "wld";
  return (
    <div className="flex-1 px-4 pt-3 pb-6 space-y-4">
      <div>
        <h2 className="text-[22px] font-semibold tracking-tight leading-tight">
          {isSol || isWld ? "Review & escrow" : "Review & stake"}
        </h2>
        <p className="text-sm text-[color:var(--color-muted)] mt-1">
          {isSol
            ? "Funds stay in the smart contract until verification passes. You can cancel any time before claim."
            : isWld
              ? "You'll sign one payment in World App to the bounty vault. The vault auto-releases on a verified cleanup or refunds you if rejected."
              : "XP is taken from your balance and paid to the claimer when verification passes."}
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
            {isSol ? (
              <>
                <CoinIcon width={16} height={16} /> {rewardSol.toFixed(2)} SOL
              </>
            ) : isWld ? (
              <>
                <WorldcoinIcon width={16} height={16} /> {formatWld(rewardWld)}
              </>
            ) : (
              <>
                <FireIcon width={16} height={16} /> {formatXp(rewardXp)}
              </>
            )}
          </span>
        </div>
      </Card>

      <Card className="p-4 grid gap-2">
        {isSol && <Row label="Network fee" value="~$0.001" />}
        {isWld && <Row label="Network fee" value="Sponsored by World App" />}
        <Row label="Verification" value="AI + sensor multi-check" />
        {isSol && (
          <Row label="Auto-refund" value="Bounty refunds if unclaimed in 7d" />
        )}
        {isWld && (
          <Row label="If rejected" value="Vault refunds WLD to you on World Chain" />
        )}
        {!isSol && !isWld && (
          <Row label="If rejected" value="Staked XP returns to you" />
        )}
        <div className="border-t border-[color:var(--color-border)] mt-1" />
        {isSol && (
          <Row
            label="Total escrow"
            value={`${rewardSol.toFixed(2)} SOL · ~${formatUsd(usdEstimate)}`}
            bold
          />
        )}
        {isWld && (
          <Row
            label="Total escrow"
            value={`${formatWld(rewardWld)} · ~${formatUsd(wldUsdEstimate)}`}
            bold
          />
        )}
        {!isSol && !isWld && (
          <Row label="Staked" value={formatXp(rewardXp)} bold />
        )}
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
        {bounty.reward_type === "xp" ? (
          <>
            {formatReward(bounty)} is staked from your balance. The claimer pool is being notified.
          </>
        ) : bounty.reward_type === "wld" ? (
          <>
            {formatReward(bounty)} is escrowed in the World Chain vault. The claimer pool is being
            notified.
          </>
        ) : (
          <>
            {bounty.reward_sol.toFixed(2)} SOL is escrowed. The claimer pool is being notified.
          </>
        )}
      </p>
      <div className="mt-6 w-full max-w-[320px] grid gap-2">
        <Button fullWidth size="xl" onClick={onDone}>
          Back to map
        </Button>
      </div>
    </div>
  );
}
