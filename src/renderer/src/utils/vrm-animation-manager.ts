/**
 * VRM Animation Manager
 *
 * Handles idle breathing animation, mouth sync for speech, and
 * expression blending for VRM avatars via @pixiv/three-vrm.
 *
 * This is the Three.js equivalent of the Live2D WavFileHandler +
 * expression system, exposed through a singleton so the audio task
 * hook can drive lip-sync regardless of avatar type.
 */

import * as THREE from "three";
import { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";

export type ExpressionCallback = (name: string) => void;

// VRM expression preset names are lowercase strings: "happy", "sad", etc.
const EMOTION_TO_PRESET: Record<string, string> = {
  happy: "happy",
  joy: "happy",
  sad: "sad",
  sadness: "sad",
  angry: "angry",
  anger: "angry",
  surprised: "surprised",
  surprise: "surprised",
  relaxed: "relaxed",
  neutral: "neutral",
  blink: "blink",
  blinkLeft: "blinkLeft",
  blinkRight: "blinkRight",
  lookUp: "lookUp",
  lookDown: "lookDown",
  lookLeft: "lookLeft",
  lookRight: "lookRight",
};

export class VrmAnimationManager {
  private vrm: VRM | null = null;
  private clock: THREE.Clock;
  private mixer: THREE.AnimationMixer | null = null;
  private idleAction: THREE.AnimationAction | null = null;
  private blinkTimer = 0;
  private nextBlinkInterval = 3 + Math.random() * 4;
  private isBlinking = false;
  private blinkPhase = 0;
  private mouthOpenTarget = 0;
  private mouthOpenCurrent = 0;
  private currentEmotion: string = "neutral";
  private emotionWeight = 0;
  private emotionTargetWeight = 0;
  private rafId: number | null = null;
  private onExpressionChange: ExpressionCallback | null = null;

  constructor() {
    this.clock = new THREE.Clock();
  }

  /** Register a loaded VRM model and start the idle loop. */
  setModel(vrm: VRM, scene: THREE.Scene): void {
    this.vrm = vrm;
    this.clock = new THREE.Clock();
    this.setupIdleAnimation(scene);
    this.startLoop();
  }

  /** Set callback for expression change notifications. */
  setExpressionCallback(cb: ExpressionCallback): void {
    this.onExpressionChange = cb;
  }

  /** Create a subtle procedural idle (breathing + sway) clip. */
  private setupIdleAnimation(scene: THREE.Scene): void {
    if (!this.vrm) return;

    // Build a simple breathing keyframe track on the spine
    const tracks: THREE.KeyframeTrack[] = [];
    const duration = 4.0; // 4-second loop

    // Breathing: scale the spine slightly
    const spineNode = this.vrm.humanoid?.getNormalizedBoneNode(
      VRMHumanBoneName.Spine,
    );
    if (spineNode) {
      const times = [0, duration / 2, duration];
      const scaleValues = [1.0, 1.02, 1.0];
      tracks.push(
        new THREE.VectorKeyframeTrack(
          `${spineNode.name}.scale`,
          times,
          scaleValues,
        ),
      );
    }

    // Subtle arm sway
    const leftUpperArm = this.vrm.humanoid?.getNormalizedBoneNode(
      VRMHumanBoneName.LeftUpperArm,
    );
    const rightUpperArm = this.vrm.humanoid?.getNormalizedBoneNode(
      VRMHumanBoneName.RightUpperArm,
    );
    if (leftUpperArm) {
      const times = [0, duration / 2, duration];
      const rotValues = [0, 0.03, 0];
      tracks.push(
        new THREE.NumberKeyframeTrack(
          `${leftUpperArm.name}.rotation.z`,
          times,
          rotValues,
        ),
      );
    }
    if (rightUpperArm) {
      const times = [0, duration / 2, duration];
      const rotValues = [0, -0.03, 0];
      tracks.push(
        new THREE.NumberKeyframeTrack(
          `${rightUpperArm.name}.rotation.z`,
          times,
          rotValues,
        ),
      );
    }

    if (tracks.length > 0) {
      const clip = new THREE.AnimationClip("idle", duration, tracks);
      this.mixer = new THREE.AnimationMixer(this.vrm.scene);
      this.idleAction = this.mixer.clipAction(clip);
      this.idleAction.setLoop(THREE.LoopRepeat, Infinity);
      this.idleAction.play();
    }
  }

  /** Start the render/animation loop. */
  private startLoop(): void {
    if (this.rafId !== null) return;
    const animate = () => {
      this.update();
      this.rafId = requestAnimationFrame(animate);
    };
    animate();
  }

  /** Stop the animation loop. */
  stopLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /** Main per-frame update: idle, blink, mouth, emotion. */
  update(): void {
    if (!this.vrm) return;
    const delta = this.clock.getDelta();

    // Update idle mixer
    if (this.mixer) {
      this.mixer.update(delta);
    }

    // Blink logic
    this.updateBlink(delta);

    // Mouth smoothing
    this.mouthOpenCurrent +=
      (this.mouthOpenTarget - this.mouthOpenCurrent) * 0.3;
    this.vrm.expressionManager?.setValue("aa", this.mouthOpenCurrent);

    // Emotion weight smoothing
    this.emotionWeight += (this.emotionTargetWeight - this.emotionWeight) * 0.1;
    const preset = EMOTION_TO_PRESET[this.currentEmotion];
    if (preset) {
      this.vrm.expressionManager?.setValue(preset, this.emotionWeight);
    }

    // Apply humanoid pose update
    this.vrm.update(delta);
  }

  /** Natural blink cycle. */
  private updateBlink(delta: number): void {
    if (!this.vrm) return;
    this.blinkTimer += delta;

    if (!this.isBlinking && this.blinkTimer >= this.nextBlinkInterval) {
      this.isBlinking = true;
      this.blinkPhase = 0;
      this.blinkTimer = 0;
    }

    if (this.isBlinking) {
      this.blinkPhase += delta * 8; // blink speed
      const value =
        this.blinkPhase < 1
          ? this.blinkPhase
          : Math.max(0, 2 - this.blinkPhase);
      this.vrm.expressionManager?.setValue("blink", value);
      if (this.blinkPhase >= 2) {
        this.isBlinking = false;
        this.nextBlinkInterval = 3 + Math.random() * 4;
        this.vrm.expressionManager?.setValue("blink", 0);
      }
    }
  }

  /**
   * Set the mouth open amount (0..1) for lip sync.
   * Called by the audio manager during speech playback.
   */
  setMouthOpen(value: number): void {
    this.mouthOpenTarget = Math.max(0, Math.min(1, value));
  }

  /** Reset mouth to closed. */
  resetMouth(): void {
    this.mouthOpenTarget = 0;
  }

  /**
   * Set an emotional expression by name.
   * Accepts common keywords (happy, sad, angry, etc.) or VRM preset names.
   */
  setExpression(
    emotion: string | number,
    emotionMap?: Record<string, string | number>,
  ): void {
    let emotionName = "";

    // If a number, look up via emotionMap (like Live2D index)
    if (typeof emotion === "number" && emotionMap) {
      const entry = Object.entries(emotionMap).find(
        ([, val]) => val === emotion,
      );
      emotionName = entry ? entry[0].toLowerCase() : "";
    } else if (typeof emotion === "string") {
      emotionName = emotion.toLowerCase();
    }

    if (emotionName && EMOTION_TO_PRESET[emotionName]) {
      // Clear previous emotion
      const oldPreset = EMOTION_TO_PRESET[this.currentEmotion];
      if (oldPreset) {
        this.vrm?.expressionManager?.setValue(oldPreset, 0);
      }
      this.currentEmotion = emotionName;
      this.emotionTargetWeight = 1.0;
      this.onExpressionChange?.(emotionName);
    } else {
      console.warn(`[VRM] Unknown expression: ${emotionName}`);
    }
  }

  /** Reset to neutral expression. */
  resetExpression(): void {
    const oldPreset = EMOTION_TO_PRESET[this.currentEmotion];
    if (oldPreset) {
      this.vrm?.expressionManager?.setValue(oldPreset, 0);
    }
    this.currentEmotion = "neutral";
    this.emotionTargetWeight = 0;
    this.resetMouth();
  }

  /** Clean up resources. */
  dispose(): void {
    this.stopLoop();
    this.mixer?.stopAllAction();
    this.idleAction = null;
    this.mixer = null;
    this.vrm = null;
  }
}

/** Singleton instance shared across the app. */
export const vrmAnimationManager = new VrmAnimationManager();
