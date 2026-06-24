/**
 * VRM Canvas Component
 *
 * Renders a VRM 3D avatar using Three.js + @pixiv/three-vrm.
 * This component mirrors the Live2D component structure, handling:
 *   - Three.js scene/camera/renderer setup
 *   - VRM model loading from URL
 *   - Idle animation, blink, expressions, and mouth sync
 *   - The same hooks (audio task, websocket, etc.)
 *
 * The component also registers the VRM animation manager on the
 * global window object so that use-audio-task can detect VRM mode.
 */

import { memo, useRef, useEffect } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin } from "@pixiv/three-vrm";
import { useLive2DConfig } from "@/context/live2d-config-context";
import { useAiState, AiStateEnum } from "@/context/ai-state-context";
import { useMode } from "@/context/mode-context";
import { useIpcHandlers } from "@/hooks/utils/use-ipc-handlers";
import { useInterrupt } from "@/hooks/utils/use-interrupt";
import { useAudioTask } from "@/hooks/utils/use-audio-task";
import { useForceIgnoreMouse } from "@/hooks/utils/use-force-ignore-mouse";
import { vrmAnimationManager } from "@/utils/vrm-animation-manager";

interface VrmCanvasProps {
  showSidebar?: boolean;
}

export const VrmCanvas = memo(
  ({ showSidebar }: VrmCanvasProps): JSX.Element => {
    const { forceIgnoreMouse } = useForceIgnoreMouse();
    const { modelInfo } = useLive2DConfig();
    const { mode } = useMode();
    const { aiState } = useAiState();
    const isPet = mode === "pet";

    const mountRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const vrmRef = useRef<any>(null);
    const clockRef = useRef<THREE.Clock>(new THREE.Clock());

    // Setup hooks (same as Live2D)
    useIpcHandlers();
    useInterrupt();
    useAudioTask();

    // Initialize Three.js scene once
    useEffect(() => {
      if (!mountRef.current) return;

      const mount = mountRef.current;
      const width = mount.clientWidth || 800;
      const height = mount.clientHeight || 600;

      // Scene
      const scene = new THREE.Scene();
      sceneRef.current = scene;

      // Camera
      const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 20);
      camera.position.set(0, 1.3, 3);
      camera.lookAt(0, 1.3, 0);
      cameraRef.current = camera;

      // Renderer
      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
      });
      renderer.setSize(width, height);
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setClearColor(0x000000, 0);
      mount.appendChild(renderer.domElement);
      rendererRef.current = renderer;

      // Lighting
      const ambient = new THREE.AmbientLight(0xffffff, 0.6);
      scene.add(ambient);
      const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
      dirLight.position.set(1, 2, 1);
      scene.add(dirLight);

      // Render loop
      let rafId: number;
      const clock = clockRef.current;
      const renderLoop = () => {
        rafId = requestAnimationFrame(renderLoop);
        const delta = clock.getDelta();
        vrmAnimationManager.update();
        renderer.render(scene, camera);
      };
      renderLoop();

      // Handle resize
      const handleResize = () => {
        if (!mount) return;
        const w = mount.clientWidth;
        const h = mount.clientHeight;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      window.addEventListener("resize", handleResize);

      // Cleanup
      return () => {
        cancelAnimationFrame(rafId);
        window.removeEventListener("resize", handleResize);
        vrmAnimationManager.dispose();
        renderer.dispose();
        if (mount.contains(renderer.domElement)) {
          mount.removeChild(renderer.domElement);
        }
        // Clear VRM mode flag so audio system falls back to Live2D
        (window as any).isVRMMode = false;
        (window as any).vrmAnimationManager = undefined;
      };
    }, []);

    // Load VRM model when modelInfo changes
    useEffect(() => {
      if (!sceneRef.current || !modelInfo) return;

      const modelUrl =
        (modelInfo as any).url ||
        (modelInfo as any).modelURL ||
        (modelInfo as any).vrmUrl;
      if (!modelUrl) {
        console.error("[VRM] No model URL in modelInfo");
        return;
      }

      const loader = new GLTFLoader();
      loader.register((parser: any) => new VRMLoaderPlugin(parser));

      const fullUrl = modelUrl.startsWith("http")
        ? modelUrl
        : `${window.location.origin}${modelUrl}`;

      console.log(`[VRM] Loading model from: ${fullUrl}`);

      loader.load(
        fullUrl,
        (gltf: any) => {
          const vrm = gltf.userData.vrm;
          if (!vrm) {
            console.error("[VRM] No VRM data in gltf");
            return;
          }

          // Remove previous VRM from scene
          if (vrmRef.current) {
            sceneRef.current?.remove(vrmRef.current.scene);
          }

          vrmRef.current = vrm;

          // Rotate to face camera (VRM faces -Z by default)
          vrm.scene.rotation.y = Math.PI;

          // Center the model
          const box = new THREE.Box3().setFromObject(vrm.scene);
          const center = box.getCenter(new THREE.Vector3());
          vrm.scene.position.sub(center);
          vrm.scene.position.y -= box.min.y - center.y; // floor

          sceneRef.current?.add(vrm.scene);

          // Register with animation manager
          vrmAnimationManager.setModel(vrm, sceneRef.current!);

          // Register on window for audio task hook to detect VRM mode
          (window as any).vrmAnimationManager = vrmAnimationManager;
          (window as any).isVRMMode = true;

          console.log("[VRM] Model loaded successfully");
        },
        (progress: any) => {
          if (progress.total) {
            console.log(
              `[VRM] Loading: ${Math.round((progress.loaded / progress.total) * 100)}%`,
            );
          }
        },
        (error: any) => {
          console.error("[VRM] Failed to load model:", error);
        },
      );
    }, [modelInfo]);

    // Reset expression when idle
    useEffect(() => {
      if (aiState === AiStateEnum.IDLE) {
        vrmAnimationManager.resetExpression();
      }
    }, [aiState]);

    return (
      <div
        id="vrm-container"
        ref={mountRef}
        style={{
          width: "100%",
          height: "100%",
          pointerEvents: isPet && forceIgnoreMouse ? "none" : "auto",
          overflow: "hidden",
          position: "relative",
        }}
      />
    );
  },
);

VrmCanvas.displayName = "VrmCanvas";

export { useInterrupt, useAudioTask };
