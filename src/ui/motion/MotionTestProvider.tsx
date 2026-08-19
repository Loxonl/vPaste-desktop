import type { PropsWithChildren } from "react";
import { domMax } from "motion/react";
import { LazyMotion, MotionConfig } from ".";

type MotionTestProviderProps = PropsWithChildren<{
    reducedMotion?: "always" | "never";
}>;

export function MotionTestProvider({ children, reducedMotion = "never" }: MotionTestProviderProps) {
    return (
        <LazyMotion features={domMax} strict>
            <MotionConfig reducedMotion={reducedMotion}>{children}</MotionConfig>
        </LazyMotion>
    );
}
