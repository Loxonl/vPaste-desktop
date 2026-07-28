import CircularProgress from "@mui/material/CircularProgress";
import styles from "./RouteFallback.module.css";

export default function RouteFallback() {
    return (
        <div className={styles.fallback} role="status" aria-label="Loading">
            <CircularProgress size={24} />
        </div>
    );
}
