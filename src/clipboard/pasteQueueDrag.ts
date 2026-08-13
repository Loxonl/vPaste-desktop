export type QueueRowMetric = {
    hash: string;
    top: number;
    height: number;
};

function metricMap(metrics: QueueRowMetric[]) {
    return new Map(metrics.map(metric => [metric.hash, metric]));
}

export function clampQueueDragOffset(
    metrics: QueueRowMetric[],
    draggedHash: string,
    offset: number,
) {
    const dragged = metrics.find(metric => metric.hash === draggedHash);
    if (!dragged || metrics.length === 0) return 0;
    const listTop = Math.min(...metrics.map(metric => metric.top));
    const listBottom = Math.max(...metrics.map(metric => metric.top + metric.height));
    return Math.min(
        listBottom - dragged.top - dragged.height,
        Math.max(listTop - dragged.top, offset),
    );
}

export function queueOrderForOffset(
    metrics: QueueRowMetric[],
    draggedHash: string,
    rawOffset: number,
) {
    const dragged = metrics.find(metric => metric.hash === draggedHash);
    if (!dragged) return metrics.map(metric => metric.hash);
    const draggedCenter = dragged.top + rawOffset + dragged.height / 2;
    const remaining = metrics.filter(metric => metric.hash !== draggedHash);
    const insertAt = remaining.findIndex(
        metric => draggedCenter < metric.top + metric.height / 2,
    );
    const order = remaining.map(metric => metric.hash);
    order.splice(insertAt < 0 ? order.length : insertAt, 0, draggedHash);
    return order;
}

export function queueVerticalTransforms(
    metrics: QueueRowMetric[],
    order: string[],
    draggedHash: string,
    draggedOffset: number,
) {
    if (metrics.length === 0) return {} as Record<string, number>;
    const byHash = metricMap(metrics);
    const transforms: Record<string, number> = {};
    let targetTop = Math.min(...metrics.map(metric => metric.top));
    for (const hash of order) {
        const metric = byHash.get(hash);
        if (!metric) continue;
        transforms[hash] = hash === draggedHash
            ? draggedOffset
            : targetTop - metric.top;
        targetTop += metric.height;
    }
    return transforms;
}
