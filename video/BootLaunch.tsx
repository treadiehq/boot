import type { CSSProperties, ReactNode } from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Audio } from "@remotion/media";

export const BOOT_LAUNCH_FPS = 30;
export const BOOT_LAUNCH_DURATION = 1350;

const palette = {
  ink: "#182133",
  inkSoft: "#48566C",
  line: "rgba(46, 65, 90, 0.15)",
  white: "#FFFFFF",
  blue: "#4B8FD8",
  cyan: "#57B8C9",
  green: "#52A779",
  violet: "#7667C5",
  orange: "#E48649",
  red: "#D96868",
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
  delay: number,
  distance = 40,
  duration = 20,
): CSSProperties => {
  const progress = interpolate(frame, [delay, delay + duration], [0, 1], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });

  return {
    opacity: progress,
    transform: `translateY(${(1 - progress) * distance}px)`,
  };
};

const fadeScene = (frame: number, duration: number, first = false): number =>
  interpolate(
    frame,
    first ? [duration - 18, duration] : [0, 18, duration - 18, duration],
    first ? [1, 0] : [0, 1, 1, 0],
    clamp,
  );

const GradientBackground: React.FC = () => {
  const frame = useCurrentFrame();
  const x = Math.sin(frame / 150) * 38;
  const y = Math.cos(frame / 180) * 24;

  return (
    <AbsoluteFill
      style={{
        overflow: "hidden",
        background:
          "linear-gradient(115deg, #A8D4F3 0%, #CADCE8 26%, #DDD7D2 57%, #F6C092 78%, #F1A260 100%)",
      }}
    >
      <div
        style={{
          position: "absolute",
          width: 1050,
          height: 1050,
          left: -270 + x,
          top: -470 + y,
          borderRadius: "50%",
          background: "rgba(196, 229, 255, 0.72)",
          filter: "blur(120px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 950,
          height: 950,
          right: -220 - x,
          bottom: -520 - y,
          borderRadius: "50%",
          background: "rgba(255, 145, 73, 0.42)",
          filter: "blur(130px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 720,
          height: 720,
          left: 640 - x / 2,
          top: 120,
          borderRadius: "50%",
          background: "rgba(255, 255, 255, 0.28)",
          filter: "blur(130px)",
        }}
      />
      <AbsoluteFill
        style={{
          opacity: 0.055,
          mixBlendMode: "multiply",
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 220 220' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.82' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.68'/%3E%3C/svg%3E\")",
        }}
      />
    </AbsoluteFill>
  );
};

const BootMark: React.FC<{
  size: number;
  tone?: "white" | "ink";
  withName?: boolean;
}> = ({ size, tone = "white", withName = false }) => {
  const filter =
    tone === "ink"
      ? "brightness(0) saturate(100%) invert(11%) sepia(15%) saturate(1766%) hue-rotate(179deg) brightness(94%) contrast(93%)"
      : undefined;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: size * 0.2 }}>
      <Img
        src={staticFile("boot-logo.png")}
        style={{
          width: size,
          height: size,
          objectFit: "contain",
          filter,
        }}
      />
      {withName && (
        <span
          style={{
            fontSize: size * 0.78,
            lineHeight: 1,
            fontWeight: 720,
            color: tone === "white" ? palette.white : palette.ink,
            letterSpacing: -size * 0.045,
          }}
        >
          Boot
        </span>
      )}
    </div>
  );
};

const GlassWindow: React.FC<{
  title: string;
  children: ReactNode;
  style?: CSSProperties;
  dark?: boolean;
}> = ({ title, children, style, dark = false }) => (
  <div
    style={{
      overflow: "hidden",
      borderRadius: 26,
      background: dark ? "rgba(20, 28, 42, 0.96)" : "rgba(255, 255, 255, 0.90)",
      border: `1px solid ${dark ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.82)"}`,
      boxShadow: "0 42px 120px rgba(57, 72, 91, 0.24)",
      backdropFilter: "blur(24px)",
      ...style,
    }}
  >
    <div
      style={{
        height: 62,
        position: "relative",
        display: "flex",
        alignItems: "center",
        padding: "0 23px",
        borderBottom: `1px solid ${
          dark ? "rgba(255,255,255,0.09)" : "rgba(68,81,100,0.10)"
        }`,
      }}
    >
      <div style={{ display: "flex", gap: 10 }}>
        {[palette.red, "#E7B55A", "#62AD74"].map((color) => (
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
          color: dark ? "rgba(255,255,255,0.48)" : palette.inkSoft,
          fontFamily: monoFont,
          fontSize: 15,
          fontWeight: 550,
        }}
      >
        {title}
      </div>
    </div>
    {children}
  </div>
);

type TerminalTone = "normal" | "muted" | "success" | "accent" | "strong";

interface TerminalLine {
  text: string;
  delay: number;
  tone?: TerminalTone;
}

const terminalColor = (tone: TerminalTone | undefined, dark: boolean): string => {
  if (tone === "success") return dark ? "#8EE6A7" : palette.green;
  if (tone === "accent") return dark ? "#8EDAF3" : palette.blue;
  if (tone === "muted") return dark ? "rgba(255,255,255,0.43)" : "#7F8B9C";
  if (tone === "strong") return dark ? palette.white : palette.ink;
  return dark ? "rgba(255,255,255,0.80)" : palette.inkSoft;
};

const TerminalBody: React.FC<{
  frame: number;
  command: string;
  commandDelay: number;
  lines: TerminalLine[];
  dark?: boolean;
  fontSize?: number;
}> = ({ frame, command, commandDelay, lines, dark = false, fontSize = 21 }) => {
  const typed = Math.floor(
    interpolate(
      frame,
      [commandDelay, commandDelay + Math.min(48, command.length * 1.1)],
      [0, command.length],
      clamp,
    ),
  );

  return (
    <div
      style={{
        padding: "33px 39px",
        fontFamily: monoFont,
        fontSize,
        lineHeight: 1.55,
      }}
    >
      <div style={{ color: dark ? palette.white : palette.ink, fontWeight: 650 }}>
        <span style={{ color: dark ? "#8EDAF3" : palette.blue }}>$ </span>
        {command.slice(0, typed)}
        {typed < command.length && (
          <span style={{ opacity: Math.floor(frame / 10) % 2, color: palette.blue }}>▋</span>
        )}
      </div>
      <div style={{ marginTop: 19 }}>
        {lines.map((line) => {
          const progress = interpolate(frame, [line.delay, line.delay + 8], [0, 1], clamp);
          return (
            <div
              key={`${line.delay}-${line.text}`}
              style={{
                minHeight: fontSize * 1.55,
                whiteSpace: "pre",
                color: terminalColor(line.tone, dark),
                fontWeight: line.tone === "strong" ? 700 : 470,
                opacity: progress,
                transform: `translateY(${(1 - progress) * 7}px)`,
              }}
            >
              {line.text}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const PromiseScene: React.FC = () => {
  const frame = useCurrentFrame();
  const duration = 150;
  const { fps } = useVideoConfig();
  const mark = spring({
    frame: frame - 5,
    fps,
    config: { damping: 16, mass: 0.8, stiffness: 100 },
  });

  return (
    <AbsoluteFill style={{ opacity: fadeScene(frame, duration, true) }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          textAlign: "center",
        }}
      >
        <div
          style={{
            opacity: mark,
            transform: `scale(${0.78 + mark * 0.22})`,
            marginBottom: 52,
          }}
        >
          <BootMark size={74} />
        </div>
        <div
          style={{
            fontSize: 106,
            lineHeight: 0.99,
            fontWeight: 760,
            color: palette.white,
            letterSpacing: -6.2,
            textShadow: "0 5px 30px rgba(65, 75, 91, 0.12)",
          }}
        >
          <div style={reveal(frame, 12, 45, 26)}>Your workspace,</div>
          <div style={reveal(frame, 35, 45, 26)}>on every machine.</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const SetupScene: React.FC = () => {
  const frame = useCurrentFrame();
  const duration = 210;

  return (
    <AbsoluteFill style={{ opacity: fadeScene(frame, duration) }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 78,
          textAlign: "center",
          color: palette.white,
          fontSize: 47,
          fontWeight: 730,
          letterSpacing: -2.2,
          ...reveal(frame, 7, 26, 20),
        }}
      >
        Set it up once.
      </div>
      <GlassWindow
        title="Terminal — ~/code"
        style={{
          position: "absolute",
          left: 170,
          top: 175,
          width: 1580,
          height: 735,
          ...reveal(frame, 16, 38, 24),
        }}
      >
        <TerminalBody
          frame={frame}
          command="boot setup git@github.com:me/code-map.git ~/code"
          commandDelay={35}
          fontSize={23}
          lines={[
            { text: "Connecting workspace map…", tone: "muted", delay: 92 },
            { text: "✓ linked private workspace map", tone: "success", delay: 108 },
            { text: "✓ found 47 repositories in ~/code", tone: "success", delay: 122 },
            { text: "✓ created encrypted secret key", tone: "success", delay: 136 },
            { text: "✓ installed shell hook + background sync", tone: "success", delay: 150 },
            { text: "", delay: 156 },
            { text: "Workspace ready.", tone: "strong", delay: 166 },
          ]}
        />
      </GlassWindow>
    </AbsoluteFill>
  );
};

const Device: React.FC<{
  frame: number;
  delay: number;
  label: string;
  detail: string;
  icon: string;
}> = ({ frame, delay, label, detail, icon }) => {
  const progress = spring({
    frame: frame - delay,
    fps: BOOT_LAUNCH_FPS,
    config: { damping: 16, mass: 0.75, stiffness: 105 },
  });

  return (
    <div
      style={{
        width: 390,
        height: 270,
        borderRadius: 28,
        background: "rgba(255,255,255,0.88)",
        border: "1px solid rgba(255,255,255,0.82)",
        boxShadow: "0 34px 90px rgba(62,76,94,0.18)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        opacity: progress,
        transform: `translateY(${(1 - progress) * 36}px) scale(${0.92 + progress * 0.08})`,
      }}
    >
      <div
        style={{
          width: 78,
          height: 78,
          display: "grid",
          placeItems: "center",
          borderRadius: 21,
          background: "#EAF2F8",
          color: palette.blue,
          fontFamily: monoFont,
          fontWeight: 760,
          fontSize: 29,
          marginBottom: 24,
        }}
      >
        {icon}
      </div>
      <div style={{ color: palette.ink, fontSize: 29, fontWeight: 720 }}>{label}</div>
      <div
        style={{
          color: palette.inkSoft,
          fontFamily: monoFont,
          fontSize: 17,
          marginTop: 9,
        }}
      >
        {detail}
      </div>
    </div>
  );
};

const MapScene: React.FC = () => {
  const frame = useCurrentFrame();
  const duration = 210;
  const line = interpolate(frame, [28, 78], [0, 1], clamp);
  const mapProgress = spring({
    frame: frame - 34,
    fps: BOOT_LAUNCH_FPS,
    config: { damping: 15, mass: 0.8, stiffness: 98 },
  });

  return (
    <AbsoluteFill style={{ opacity: fadeScene(frame, duration) }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 86,
          textAlign: "center",
          color: palette.white,
          fontSize: 58,
          lineHeight: 1,
          fontWeight: 750,
          letterSpacing: -3.2,
          ...reveal(frame, 5, 28, 20),
        }}
      >
        Sync the layout. Not the files.
      </div>

      <svg
        width="1920"
        height="1080"
        viewBox="0 0 1920 1080"
        style={{ position: "absolute", inset: 0 }}
      >
        <line
          x1="575"
          y1="510"
          x2="840"
          y2="510"
          stroke="rgba(255,255,255,0.76)"
          strokeWidth="4"
          strokeDasharray="11 13"
          strokeDashoffset={300 * (1 - line)}
        />
        <line
          x1="1080"
          y1="510"
          x2="1345"
          y2="510"
          stroke="rgba(255,255,255,0.76)"
          strokeWidth="4"
          strokeDasharray="11 13"
          strokeDashoffset={300 * (1 - line)}
        />
      </svg>

      <div
        style={{
          position: "absolute",
          left: 165,
          right: 165,
          top: 340,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Device frame={frame} delay={15} label="MacBook" detail="47 real repos" icon="⌘" />

        <div
          style={{
            width: 270,
            height: 270,
            borderRadius: "50%",
            background: "rgba(31,44,64,0.92)",
            boxShadow: "0 35px 100px rgba(50,66,88,0.28)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            opacity: mapProgress,
            transform: `scale(${0.82 + mapProgress * 0.18})`,
          }}
        >
          <BootMark size={76} />
          <div
            style={{
              marginTop: 22,
              color: palette.white,
              fontSize: 26,
              fontWeight: 690,
            }}
          >
            the map
          </div>
          <div
            style={{
              marginTop: 7,
              color: "rgba(255,255,255,0.54)",
              fontFamily: monoFont,
              fontSize: 14,
            }}
          >
            tiny private repo
          </div>
        </div>

        <Device
          frame={frame}
          delay={51}
          label="New machine"
          detail="47 placeholders"
          icon="◇"
        />
      </div>

      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 95,
          textAlign: "center",
          color: "rgba(255,255,255,0.82)",
          fontSize: 28,
          fontWeight: 560,
          ...reveal(frame, 105, 20, 18),
        }}
      >
        The shape of your workspace appears in seconds.
      </div>
    </AbsoluteFill>
  );
};

interface FolderRowProps {
  frame: number;
  delay: number;
  name: string;
  path: string;
  real?: boolean;
}

const FolderRow: React.FC<FolderRowProps> = ({ frame, delay, name, path, real = false }) => {
  const progress = interpolate(frame, [delay, delay + 13], [0, 1], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });

  return (
    <div
      style={{
        height: 76,
        display: "flex",
        alignItems: "center",
        gap: 17,
        padding: "0 23px",
        borderBottom: "1px solid rgba(45,65,90,0.08)",
        opacity: progress,
        transform: `translateX(${(1 - progress) * 25}px)`,
      }}
    >
      <div
        style={{
          width: 37,
          height: 31,
          borderRadius: 8,
          background: real ? "#71B68D" : "#8EB7D7",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            width: 17,
            height: 7,
            borderRadius: "5px 5px 0 0",
            left: 3,
            top: -4,
            background: real ? "#71B68D" : "#8EB7D7",
          }}
        />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ color: palette.ink, fontSize: 20, fontWeight: 650 }}>{name}</div>
        <div
          style={{
            color: "#8490A0",
            fontFamily: monoFont,
            fontSize: 14,
            marginTop: 3,
          }}
        >
          {path}
        </div>
      </div>
      <div
        style={{
          padding: "7px 11px",
          borderRadius: 999,
          color: real ? palette.green : palette.blue,
          background: real ? "#E6F4EB" : "#E8F2F9",
          fontFamily: monoFont,
          fontSize: 12,
          fontWeight: 680,
        }}
      >
        {real ? "real clone" : "placeholder"}
      </div>
    </div>
  );
};

const TouchScene: React.FC = () => {
  const frame = useCurrentFrame();
  const duration = 210;
  const hydrated = frame >= 135;

  return (
    <AbsoluteFill style={{ opacity: fadeScene(frame, duration) }}>
      <div
        style={{
          position: "absolute",
          left: 126,
          top: 96,
          color: palette.white,
          fontSize: 60,
          lineHeight: 1,
          fontWeight: 750,
          letterSpacing: -3.3,
          ...reveal(frame, 5, 28, 20),
        }}
      >
        Touch a repo. It becomes real.
      </div>

      <GlassWindow
        title="~/code"
        style={{
          position: "absolute",
          left: 126,
          top: 210,
          width: 820,
          height: 705,
          ...reveal(frame, 15, 35, 23),
        }}
      >
        <div style={{ padding: "18px 24px 0" }}>
          <div
            style={{
              color: "#8A96A6",
              fontFamily: monoFont,
              fontSize: 14,
              margin: "5px 0 13px",
            }}
          >
            47 repositories
          </div>
          <FolderRow frame={frame} delay={37} name="web" path="apps/web" />
          <FolderRow frame={frame} delay={49} name="billing" path="services/billing" />
          <FolderRow
            frame={frame}
            delay={61}
            name="kplane"
            path="apps/kplane"
            real={hydrated}
          />
          <FolderRow frame={frame} delay={73} name="design-system" path="libs/ui" />
          <FolderRow frame={frame} delay={85} name="analytics" path="services/analytics" />
        </div>
      </GlassWindow>

      <GlassWindow
        title="Terminal"
        dark
        style={{
          position: "absolute",
          right: 126,
          top: 315,
          width: 730,
          height: 500,
          ...reveal(frame, 34, 35, 23),
        }}
      >
        <TerminalBody
          frame={frame}
          command="cd ~/code/apps/kplane"
          commandDelay={77}
          dark
          fontSize={20}
          lines={[
            { text: "placeholder found", tone: "muted", delay: 119 },
            { text: "↓ cloning github.com/acme/kplane", tone: "accent", delay: 133 },
            { text: "✓ cloned apps/kplane (1.8s)", tone: "success", delay: 154 },
            { text: "", delay: 159 },
            { text: "~/code/apps/kplane", tone: "strong", delay: 169 },
          ]}
        />
      </GlassWindow>
    </AbsoluteFill>
  );
};

const AgentScene: React.FC = () => {
  const frame = useCurrentFrame();
  const duration = 150;

  return (
    <AbsoluteFill style={{ opacity: fadeScene(frame, duration) }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 72,
          textAlign: "center",
          color: palette.white,
          fontSize: 55,
          fontWeight: 750,
          letterSpacing: -3,
          ...reveal(frame, 5, 25, 20),
        }}
      >
        Fresh cloud agent. Ready in seconds.
      </div>

      <GlassWindow
        title="cloud-agent — /workspace"
        dark
        style={{
          position: "absolute",
          left: 210,
          top: 180,
          width: 1500,
          height: 750,
          ...reveal(frame, 14, 35, 23),
        }}
      >
        <TerminalBody
          frame={frame}
          command="boot agent git@github.com:me/code-map.git /workspace"
          commandDelay={27}
          dark
          fontSize={22}
          lines={[
            { text: "Preparing profile: agent", tone: "muted", delay: 75 },
            { text: "✓ web      apps/web", tone: "success", delay: 87 },
            { text: "✓ billing  services/billing", tone: "success", delay: 97 },
            { text: "✓ sdk      packages/sdk", tone: "success", delay: 107 },
            { text: "✓ encrypted environment available", tone: "success", delay: 117 },
            { text: "", delay: 120 },
            { text: "Agent workspace ready.", tone: "strong", delay: 128 },
          ]}
        />
      </GlassWindow>
    </AbsoluteFill>
  );
};

const StatementScene: React.FC<{
  duration: number;
  eyebrow: string;
  children: ReactNode;
  align?: "center" | "left";
}> = ({ duration, eyebrow, children, align = "center" }) => {
  const frame = useCurrentFrame();
  const isCenter = align === "center";

  return (
    <AbsoluteFill style={{ opacity: fadeScene(frame, duration) }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: isCenter ? "center" : "flex-start",
          textAlign: align,
          padding: isCenter ? 0 : "0 280px",
        }}
      >
        <div
          style={{
            color: "rgba(255,255,255,0.70)",
            fontFamily: monoFont,
            fontSize: 20,
            textTransform: "uppercase",
            letterSpacing: 3,
            fontWeight: 650,
            marginBottom: 27,
            ...reveal(frame, 4, 20, 17),
          }}
        >
          {eyebrow}
        </div>
        <div
          style={{
            maxWidth: 1450,
            color: palette.white,
            fontSize: 100,
            lineHeight: 0.98,
            fontWeight: 760,
            letterSpacing: -6,
            textShadow: "0 5px 30px rgba(65,75,91,0.10)",
            ...reveal(frame, 14, 38, 22),
          }}
        >
          {children}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const FinaleScene: React.FC = () => {
  const frame = useCurrentFrame();
  const duration = 120;
  const logo = spring({
    frame: frame - 4,
    fps: BOOT_LAUNCH_FPS,
    config: { damping: 15, mass: 0.85, stiffness: 95 },
  });

  return (
    <AbsoluteFill style={{ opacity: fadeScene(frame, duration) }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            opacity: logo,
            transform: `scale(${0.78 + logo * 0.22})`,
          }}
        >
          <BootMark size={160} withName />
        </div>
        <div
          style={{
            marginTop: 50,
            color: "rgba(255,255,255,0.88)",
            fontFamily: monoFont,
            fontSize: 24,
            letterSpacing: 1.1,
            ...reveal(frame, 45, 20, 18),
          }}
        >
          useboot.co
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const BootLaunch: React.FC = () => {
  return (
    <AbsoluteFill style={{ fontFamily: displayFont }}>
      <GradientBackground />

      <Sequence from={0} durationInFrames={150}>
        <PromiseScene />
      </Sequence>
      <Sequence from={135} durationInFrames={210}>
        <SetupScene />
      </Sequence>
      <Sequence from={330} durationInFrames={210}>
        <MapScene />
      </Sequence>
      <Sequence from={525} durationInFrames={210}>
        <TouchScene />
      </Sequence>
      <Sequence from={720} durationInFrames={150}>
        <AgentScene />
      </Sequence>

      <Sequence from={855} durationInFrames={90}>
        <StatementScene duration={90} eyebrow="On demand">
          Every repo.
          <br />
          No giant clone.
        </StatementScene>
      </Sequence>
      <Sequence from={930} durationInFrames={90}>
        <StatementScene duration={90} eyebrow="AES-256-GCM">
          Secrets travel
          <br />
          encrypted.
        </StatementScene>
      </Sequence>
      <Sequence from={1005} durationInFrames={90}>
        <StatementScene duration={90} eyebrow="Background sync">
          No stale main.
        </StatementScene>
      </Sequence>
      <Sequence from={1080} durationInFrames={90}>
        <StatementScene duration={90} eyebrow="Everywhere">
          macOS. Linux.
          <br />
          Windows. Agents.
        </StatementScene>
      </Sequence>
      <Sequence from={1155} durationInFrames={90}>
        <StatementScene duration={90} eyebrow="Built in public">
          Open source.
          <br />
          Free forever.
        </StatementScene>
      </Sequence>

      <Sequence from={1230} durationInFrames={120}>
        <FinaleScene />
      </Sequence>

      <Audio
        src={staticFile("boot-soundtrack.wav")}
        volume={(frame) =>
          interpolate(
            frame,
            [0, 18, BOOT_LAUNCH_DURATION - 42, BOOT_LAUNCH_DURATION],
            [0, 0.72, 0.72, 0],
            clamp,
          )
        }
      />
    </AbsoluteFill>
  );
};
