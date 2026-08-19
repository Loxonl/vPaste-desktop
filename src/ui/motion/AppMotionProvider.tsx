import type { PropsWithChildren } from "react";
import { LazyMotion, MotionConfig, loadMotionFeatures } from ".";

export default function AppMotionProvider({ children }: PropsWithChildren) {
    return (
        <LazyMotion features={loadMotionFeatures} strict>
            <MotionConfig reducedMotion="user">{children}</MotionConfig>
        </LazyMotion>
    );
}
