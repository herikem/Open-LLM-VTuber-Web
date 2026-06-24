/**
 * Unified Avatar Component
 *
 * Automatically renders Live2D or VRM based on the modelType in modelInfo.
 * This is the single entry point for avatar rendering — replacing direct
 * Live2D usage. It detects the avatar type and delegates to the appropriate
 * renderer without breaking any existing functionality.
 */

import { memo, useMemo } from "react";
import { useLive2DConfig } from "@/context/live2d-config-context";
import { Live2D } from "@/components/canvas/live2d";
import { VrmCanvas } from "@/components/canvas/vrm-canvas";

interface AvatarProps {
  showSidebar?: boolean;
}

export const Avatar = memo(({ showSidebar }: AvatarProps): JSX.Element => {
  const { modelInfo } = useLive2DConfig();

  // Determine avatar type: default to Live2D for backward compatibility
  const isVRM = useMemo(() => {
    const modelType = (modelInfo?.modelType || "").toLowerCase();
    return (
      modelType === "vrm" ||
      (modelInfo?.url || "").toLowerCase().endsWith(".vrm")
    );
  }, [modelInfo]);

  if (isVRM) {
    return <VrmCanvas showSidebar={showSidebar} />;
  }

  return <Live2D showSidebar={showSidebar} />;
});

Avatar.displayName = "Avatar";

export default Avatar;
