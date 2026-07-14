import { Composition } from "remotion";
import {
  BootLaunch,
  BOOT_LAUNCH_DURATION,
  BOOT_LAUNCH_FPS,
} from "./BootLaunch";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="BootLaunch"
      component={BootLaunch}
      durationInFrames={BOOT_LAUNCH_DURATION}
      fps={BOOT_LAUNCH_FPS}
      width={1920}
      height={1080}
    />
  );
};
