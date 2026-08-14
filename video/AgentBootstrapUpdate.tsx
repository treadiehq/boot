import type { CSSProperties, ReactNode } from "react";
import { Audio } from "@remotion/media";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export const AGENT_BOOTSTRAP_FPS = 30;
export const AGENT_BOOTSTRAP_DURATION = 360;

const colors = {
  ink: "#172033",
  inkSoft: "#5F697A",
  muted: "#8D96A5",
  blue: "#4B8FD8",
  green: "#3B9D6A",
  greenSoft: "#E7F5ED",
  line: "rgba(32, 47, 68, 0.10)",
  white: "#FFFFFF",
};

const displayFont =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
const monoFont =
  '"SFMono-Regular", "SF Mono", "Roboto Mono", Menlo, Consolas, monospace';
const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

const reveal = (
  frame: number,
  from: number,
  distance = 24,
  duration = 18,
): CSSProperties => {
  const progress = interpolate(frame, [from, from + duration], [0, 1], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  return {
    opacity: progress,
    transform: `translateY(${(1 - progress) * distance}px)`,
  };
};

const Gradient: React.FC = () => {
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 70) * 24;

  return (
    <AbsoluteFill
      style={{
        overflow: "hidden",
        background:
          "linear-gradient(125deg, #F7D9E6 0%, #F7E8E7 42%, #E7E8EE 68%, #CEE4F4 100%)",
      }}
    >
      <div
        style={{
          position: "absolute",
          width: 820,
          height: 820,
          left: -220 + drift,
          top: -430,
          borderRadius: "50%",
          background: "rgba(255, 168, 199, 0.30)",
          filter: "blur(110px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 900,
          height: 900,
          right: -250 - drift,
          bottom: -500,
          borderRadius: "50%",
          background: "rgba(132, 197, 239, 0.34)",
          filter: "blur(120px)",
        }}
      />
      <AbsoluteFill
        style={{
          opacity: 0.035,
          mixBlendMode: "multiply",
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.48'/%3E%3C/svg%3E\")",
        }}
      />
    </AbsoluteFill>
  );
};

const BootLogo: React.FC<{ size: number; withName?: boolean }> = ({
  size,
  withName = false,
}) => (
  <div style={{ display: "flex", alignItems: "center", gap: size * 0.2 }}>
    <Img
      src={staticFile("boot-logo.png")}
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        filter:
          "brightness(0) saturate(100%) invert(10%) sepia(20%) saturate(1500%) hue-rotate(180deg) brightness(92%) contrast(92%)",
      }}
    />
    {withName && (
      <span
        style={{
          color: colors.ink,
          fontSize: size * 0.78,
          fontWeight: 760,
          letterSpacing: -size * 0.045,
        }}
      >
        Boot
      </span>
    )}
  </div>
);

const Window: React.FC<{ children: ReactNode; style?: CSSProperties }> = ({
  children,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const entrance = spring({
    frame: frame - 13,
    fps,
    config: { damping: 17, mass: 0.9, stiffness: 105 },
  });

  return (
    <div
      style={{
        position: "absolute",
        overflow: "hidden",
        borderRadius: 28,
        background: "rgba(255,255,255,0.93)",
        border: "1px solid rgba(255,255,255,0.88)",
        boxShadow: "0 42px 115px rgba(78, 79, 101, 0.20)",
        opacity: entrance,
        transform: `translateY(${(1 - entrance) * 38}px) scale(${
          0.975 + entrance * 0.025
        })`,
        ...style,
      }}
    >
      <div
        style={{
          height: 62,
          position: "relative",
          display: "flex",
          alignItems: "center",
          padding: "0 24px",
          borderBottom: `1px solid ${colors.line}`,
        }}
      >
        <div style={{ display: "flex", gap: 10 }}>
          {["#EF7B7B", "#E8B85E", "#68B77C"].map((color) => (
            <span
              key={color}
              style={{ width: 13, height: 13, borderRadius: "50%", background: color }}
            />
          ))}
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            textAlign: "center",
            color: colors.muted,
            fontFamily: monoFont,
            fontSize: 15,
            fontWeight: 600,
          }}
        >
          cloud-agent — /workspace
        </div>
      </div>
      {children}
    </div>
  );
};

interface OutputLine {
  label: string;
  value: string;
  from: number;
  success?: boolean;
}

const OutputRow: React.FC<OutputLine> = ({
  label,
  value,
  from,
  success = false,
}) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [from, from + 10], [0, 1], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "165px 1fr",
        alignItems: "center",
        minHeight: 47,
        opacity: progress,
        transform: `translateY(${(1 - progress) * 8}px)`,
      }}
    >
      <span style={{ color: colors.muted }}>{label}</span>
      <span
        style={{
          color: success ? colors.green : colors.inkSoft,
          fontWeight: success ? 650 : 520,
        }}
      >
        {success ? "✓ " : ""}
        {value}
      </span>
    </div>
  );
};

const FeaturePill: React.FC<{
  from: number;
  children: ReactNode;
}> = ({ from, children }) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [from, from + 12], [0, 1], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });

  return (
    <div
      style={{
        padding: "12px 18px",
        borderRadius: 999,
        background: "rgba(255,255,255,0.70)",
        border: "1px solid rgba(255,255,255,0.86)",
        color: colors.inkSoft,
        fontFamily: monoFont,
        fontSize: 15,
        fontWeight: 650,
        boxShadow: "0 12px 32px rgba(62,73,91,0.08)",
        opacity: progress,
        transform: `translateY(${(1 - progress) * 14}px)`,
      }}
    >
      {children}
    </div>
  );
};

const CommandDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const command =
    "curl -fsSL https://useboot.co/agent.sh | bash -s -- git@github.com:acme/map.git /workspace --profile agent";
  const typed = Math.floor(
    interpolate(frame, [38, 118], [0, command.length], clamp),
  );
  const cursorVisible = typed < command.length && Math.floor(frame / 8) % 2 === 0;
  const ready = interpolate(frame, [245, 261], [0, 1], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });

  const lines: OutputLine[] = [
    { label: "bootstrap", value: "Boot v0.3.7 installed", from: 128, success: true },
    { label: "source", value: "map.git · 8b7f4e1… · pinned", from: 143 },
    { label: "mode", value: "ephemeral · no machine-state push", from: 158 },
    { label: "repositories", value: "web · api · sdk", from: 173, success: true },
    { label: "setup", value: "declared commands completed", from: 188, success: true },
    { label: "diagnostics", value: "schema v1 · validated · secret-free", from: 203, success: true },
  ];

  return (
    <div style={{ padding: "34px 45px 35px" }}>
      <div
        style={{
          minHeight: 58,
          display: "flex",
          alignItems: "flex-start",
          color: colors.ink,
          fontFamily: monoFont,
          fontSize: 20,
          lineHeight: 1.55,
          fontWeight: 620,
          borderBottom: `1px solid ${colors.line}`,
          paddingBottom: 27,
        }}
      >
        <span style={{ color: colors.blue, marginRight: 11 }}>$</span>
        <span>{command.slice(0, typed)}</span>
        {cursorVisible && <span style={{ color: colors.blue }}>▋</span>}
      </div>

      <div
        style={{
          paddingTop: 24,
          fontFamily: monoFont,
          fontSize: 18,
          lineHeight: 1.45,
        }}
      >
        {lines.map((line) => (
          <OutputRow key={line.label} {...line} />
        ))}
      </div>

      <div
        style={{
          height: 72,
          marginTop: 22,
          borderRadius: 16,
          background: colors.greenSoft,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 22px",
          opacity: ready,
          transform: `translateY(${(1 - ready) * 9}px)`,
        }}
      >
        <span
          style={{
            color: colors.green,
            fontFamily: monoFont,
            fontSize: 19,
            fontWeight: 720,
          }}
        >
          ✓ Agent workspace ready.
        </span>
        <span
          style={{
            color: colors.green,
            fontFamily: monoFont,
            fontSize: 15,
            fontWeight: 650,
          }}
        >
          ready: true
        </span>
      </div>
    </div>
  );
};

export const AgentBootstrapUpdate: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(
    frame,
    [0, 14, AGENT_BOOTSTRAP_DURATION - 18, AGENT_BOOTSTRAP_DURATION - 1],
    [0, 1, 1, 0],
    clamp,
  );

  return (
    <AbsoluteFill style={{ fontFamily: displayFont, opacity }}>
      <Gradient />

      <div
        style={{
          position: "absolute",
          top: 58,
          left: 115,
          display: "flex",
          alignItems: "center",
          gap: 18,
          ...reveal(frame, 4, 15, 15),
        }}
      >
        <BootLogo size={47} withName />
        <span
          style={{
            padding: "8px 12px",
            borderRadius: 999,
            color: colors.blue,
            background: "rgba(255,255,255,0.64)",
            border: "1px solid rgba(255,255,255,0.82)",
            fontFamily: monoFont,
            fontSize: 14,
            fontWeight: 750,
            letterSpacing: 0.5,
          }}
        >
          v0.3.7
        </span>
      </div>

      <div
        style={{
          position: "absolute",
          top: 63,
          left: 0,
          right: 0,
          textAlign: "center",
          color: colors.ink,
          fontSize: 51,
          fontWeight: 750,
          letterSpacing: -2.5,
          ...reveal(frame, 7, 18, 16),
        }}
      >
        Fresh VM → ready agent workspace
      </div>

      <Window
        style={{
          left: 185,
          top: 160,
          width: 1550,
          height: 640,
        }}
      >
        <CommandDemo />
      </Window>

      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 72,
          display: "flex",
          justifyContent: "center",
          gap: 14,
        }}
      >
        <FeaturePill from={272}>exact map SHA</FeaturePill>
        <FeaturePill from={282}>ephemeral · no pushes</FeaturePill>
        <FeaturePill from={292}>validated JSON</FeaturePill>
        <FeaturePill from={302}>Claude · Codex · VMs</FeaturePill>
      </div>

      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 28,
          textAlign: "center",
          color: colors.inkSoft,
          fontFamily: monoFont,
          fontSize: 16,
          fontWeight: 650,
          letterSpacing: 0.5,
          ...reveal(frame, 315, 10, 14),
        }}
      >
        useboot.co
      </div>

      <Audio
        src={staticFile("boot-soundtrack.wav")}
        volume={(audioFrame) =>
          interpolate(
            audioFrame,
            [0, 18, AGENT_BOOTSTRAP_DURATION - 35, AGENT_BOOTSTRAP_DURATION],
            [0, 0.48, 0.48, 0],
            clamp,
          )
        }
      />
    </AbsoluteFill>
  );
};
