/* eslint-disable func-names */
/* eslint-disable no-underscore-dangle */
/* eslint-disable @typescript-eslint/ban-ts-comment */
import { useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAiState } from "@/context/ai-state-context";
import { useSubtitle } from "@/context/subtitle-context";
import { useChatHistory } from "@/context/chat-history-context";
import { audioTaskQueue } from "@/utils/task-queue";
import { audioManager } from "@/utils/audio-manager";
import { toaster } from "@/components/ui/toaster";
import { useWebSocket } from "@/context/websocket-context";
import { DisplayText } from "@/services/websocket-service";
import { useLive2DExpression } from "@/hooks/canvas/use-live2d-expression";
import { vrmAnimationManager } from "@/utils/vrm-animation-manager";
import * as LAppDefine from "../../../WebSDK/src/lappdefine";

/** Helper: check if we are currently in VRM mode. */
function isVRMMode(): boolean {
  return (window as any).isVRMMode === true;
}

// Simple type alias for Live2D model
type Live2DModel = any;

interface AudioTaskOptions {
  audioBase64: string;
  volumes: number[];
  sliceLength: number;
  displayText?: DisplayText | null;
  expressions?: string[] | number[] | null;
  speaker_uid?: string;
  forwarded?: boolean;
}

/**
 * Custom hook for handling audio playback tasks with Live2D/VRM lip sync
 */
export const useAudioTask = () => {
  const { t } = useTranslation();
  const { aiState, backendSynthComplete, setBackendSynthComplete } =
    useAiState();
  const { setSubtitleText } = useSubtitle();
  const { appendResponse, appendAIMessage } = useChatHistory();
  const { sendMessage } = useWebSocket();
  const { setExpression } = useLive2DExpression();

  // State refs to avoid stale closures
  const stateRef = useRef({
    aiState,
    setSubtitleText,
    appendResponse,
    appendAIMessage,
  });

  stateRef.current = {
    aiState,
    setSubtitleText,
    appendResponse,
    appendAIMessage,
  };

  /**
   * Stop current audio playback and lip sync (delegates to global audioManager)
   */
  const stopCurrentAudioAndLipSync = useCallback(() => {
    audioManager.stopCurrentAudioAndLipSync();
    // Also reset VRM mouth if in VRM mode
    if (isVRMMode()) {
      vrmAnimationManager.resetMouth();
    }
  }, []);

  /**
   * Handle audio playback with Live2D or VRM lip sync
   */
  const handleAudioPlayback = (options: AudioTaskOptions): Promise<void> =>
    new Promise((resolve) => {
      const {
        aiState: currentAiState,
        setSubtitleText: updateSubtitle,
        appendResponse: appendText,
        appendAIMessage: appendAI,
      } = stateRef.current;

      // Skip if already interrupted
      if (currentAiState === "interrupted") {
        console.warn("Audio playback blocked by interruption state.");
        resolve();
        return;
      }

      const { audioBase64, displayText, expressions, forwarded } = options;

      // Update display text
      if (displayText) {
        appendText(displayText.text);
        appendAI(displayText.text, displayText.name, displayText.avatar);
        if (audioBase64) {
          updateSubtitle(displayText.text);
        }
        if (!forwarded) {
          sendMessage({
            type: "audio-play-start",
            display_text: displayText,
            forwarded: true,
          });
        }
      }

      try {
        if (!audioBase64) {
          resolve();
          return;
        }

        const audioDataUrl = `data:audio/wav;base64,${audioBase64}`;

        // ===== VRM MODE =====
        if (isVRMMode()) {
          console.log("[VRM] Audio playback with VRM lip sync");

          // Set expression if available
          if (expressions?.[0] !== undefined) {
            vrmAnimationManager.setExpression(expressions[0]);
          }

          const audio = new Audio(audioDataUrl);
          audioManager.setCurrentAudio(audio, null);
          let isFinished = false;

          const cleanup = () => {
            audioManager.clearCurrentAudio(audio);
            vrmAnimationManager.resetMouth();
            if (!isFinished) {
              isFinished = true;
              resolve();
            }
          };

          audio.addEventListener("canplaythrough", () => {
            if (
              stateRef.current.aiState === "interrupted" ||
              !audioManager.hasCurrentAudio()
            ) {
              console.warn(
                "[VRM] Audio playback cancelled due to interruption",
              );
              cleanup();
              return;
            }

            console.log("[VRM] Starting audio playback");
            audio.play().catch((err) => {
              console.error("[VRM] Audio play error:", err);
              cleanup();
            });

            // VRM lip sync via Web Audio API amplitude analysis
            try {
              const AudioCtx =
                window.AudioContext || (window as any).webkitAudioContext;
              const audioCtx = new AudioCtx();
              const source = audioCtx.createMediaElementSource(audio);
              const analyser = audioCtx.createAnalyser();
              analyser.fftSize = 256;
              source.connect(analyser);
              analyser.connect(audioCtx.destination);

              const dataArray = new Uint8Array(analyser.frequencyBinCount);

              const updateLipSync = () => {
                if (!audioManager.hasCurrentAudio() || audio.ended) {
                  vrmAnimationManager.setMouthOpen(0);
                  return;
                }
                analyser.getByteTimeDomainData(dataArray);
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                  const v = (dataArray[i] - 128) / 128;
                  sum += v * v;
                }
                const rms = Math.sqrt(sum / dataArray.length);
                vrmAnimationManager.setMouthOpen(Math.min(1, rms * 4));
                requestAnimationFrame(updateLipSync);
              };
              updateLipSync();

              audio.addEventListener("ended", () => {
                audioCtx.close();
              });
            } catch (lipSyncErr) {
              console.warn("[VRM] Web Audio lip sync unavailable:", lipSyncErr);
            }
          });

          audio.addEventListener("ended", () => {
            console.log("[VRM] Audio playback completed");
            cleanup();
          });

          audio.addEventListener("error", (error) => {
            console.error("[VRM] Audio playback error:", error);
            cleanup();
          });

          audio.load();
          return;
        }

        // ===== LIVE2D MODE (original) =====
        const live2dManager = (window as any).getLive2DManager?.();
        if (!live2dManager) {
          console.error("Live2D manager not found");
          resolve();
          return;
        }

        const model = live2dManager.getModel(0);
        if (!model) {
          console.error("Live2D model not found at index 0");
          resolve();
          return;
        }
        console.log("Found model for audio playback");

        // Set expression if available
        const lappAdapter = (window as any).getLAppAdapter?.();
        if (lappAdapter && expressions?.[0] !== undefined) {
          setExpression(
            expressions[0],
            lappAdapter,
            `Set expression to: ${expressions[0]}`,
          );
        }

        // Start talk motion
        if (LAppDefine && LAppDefine.PriorityNormal) {
          console.log("Starting random 'Talk' motion");
          model.startRandomMotion("Talk", LAppDefine.PriorityNormal);
        } else {
          console.warn(
            "LAppDefine.PriorityNormal not found - cannot start talk motion",
          );
        }

        const audio = new Audio(audioDataUrl);
        audioManager.setCurrentAudio(audio, model);
        let isFinished = false;

        const cleanup = () => {
          audioManager.clearCurrentAudio(audio);
          if (!isFinished) {
            isFinished = true;
            resolve();
          }
        };

        const lipSyncScale = 2.0;

        audio.addEventListener("canplaythrough", () => {
          if (
            stateRef.current.aiState === "interrupted" ||
            !audioManager.hasCurrentAudio()
          ) {
            console.warn(
              "Audio playback cancelled due to interruption or audio was stopped",
            );
            cleanup();
            return;
          }

          console.log("Starting audio playback with lip sync");
          audio.play().catch((err) => {
            console.error("Audio play error:", err);
            cleanup();
          });

          if (model._wavFileHandler) {
            if (!model._wavFileHandler._initialized) {
              console.log("Applying enhanced lip sync");
              model._wavFileHandler._initialized = true;

              const originalUpdate = model._wavFileHandler.update.bind(
                model._wavFileHandler,
              );
              model._wavFileHandler.update = function (
                deltaTimeSeconds: number,
              ) {
                const result = originalUpdate(deltaTimeSeconds);
                // @ts-ignore
                this._lastRms = Math.min(2.0, this._lastRms * lipSyncScale);
                return result;
              };
            }

            if (audioManager.hasCurrentAudio()) {
              model._wavFileHandler.start(audioDataUrl);
            } else {
              console.warn("WavFileHandler start skipped - audio was stopped");
            }
          }
        });

        audio.addEventListener("ended", () => {
          console.log("Audio playback completed");
          cleanup();
        });

        audio.addEventListener("error", (error) => {
          console.error("Audio playback error:", error);
          cleanup();
        });

        audio.load();
      } catch (error) {
        console.error("Audio playback setup error:", error);
        toaster.create({
          title: `${t("error.audioPlayback")}: ${error}`,
          type: "error",
          duration: 2000,
        });
        resolve();
      }
    });

  // Handle backend synthesis completion
  useEffect(() => {
    let isMounted = true;

    const handleComplete = async () => {
      await audioTaskQueue.waitForCompletion();
      if (isMounted && backendSynthComplete) {
        stopCurrentAudioAndLipSync();
        sendMessage({ type: "frontend-playback-complete" });
        setBackendSynthComplete(false);
      }
    };

    handleComplete();

    return () => {
      isMounted = false;
    };
  }, [
    backendSynthComplete,
    sendMessage,
    setBackendSynthComplete,
    stopCurrentAudioAndLipSync,
  ]);

  /**
   * Add a new audio task to the queue
   */
  const addAudioTask = async (options: AudioTaskOptions) => {
    const { aiState: currentState } = stateRef.current;

    if (currentState === "interrupted") {
      console.log("Skipping audio task due to interrupted state");
      return;
    }

    console.log(`Adding audio task ${options.displayText?.text} to queue`);
    audioTaskQueue.addTask(() => handleAudioPlayback(options));
  };

  return {
    addAudioTask,
    appendResponse,
    stopCurrentAudioAndLipSync,
  };
};
