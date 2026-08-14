import { Composition } from "remotion";
import {
  BootLaunch,
  BOOT_LAUNCH_DURATION,
  BOOT_LAUNCH_FPS,
} from "./BootLaunch";
import {
  AgentBootstrapUpdate,
  AGENT_BOOTSTRAP_DURATION,
  AGENT_BOOTSTRAP_FPS,
} from "./AgentBootstrapUpdate";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="BootLaunch"
        component={BootLaunch}
        durationInFrames={BOOT_LAUNCH_DURATION}
        fps={BOOT_LAUNCH_FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="AgentBootstrapUpdate"
        component={AgentBootstrapUpdate}
        durationInFrames={AGENT_BOOTSTRAP_DURATION}
        fps={AGENT_BOOTSTRAP_FPS}
        width={1920}
        height={1080}
      />
    </>
  );
};
