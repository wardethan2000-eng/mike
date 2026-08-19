"use client";

import { createPortal } from "react-dom";
import { WarningPopup } from "../popups/WarningPopup";

interface Props {
    open: boolean;
    /** Limit the overlay to this rectangle instead of the whole window, so it
     * only covers the area that will actually take the drop. */
    bounds?: DOMRect | null;
    label?: string;
    warning?: string | null;
    onWarningClose?: () => void;
}

export function UploadOverlay({
    open,
    bounds,
    label = "Drop files here to add to chat",
    warning,
    onWarningClose,
}: Props) {
    return (
        <>
            {open &&
                createPortal(
                    <div
                        className="pointer-events-none fixed z-[260] flex items-center justify-center bg-white/35 p-6 backdrop-blur-md"
                        style={
                            bounds
                                ? {
                                      top: bounds.top,
                                      left: bounds.left,
                                      width: bounds.width,
                                      height: bounds.height,
                                  }
                                : { inset: 0 }
                        }
                    >
                        <p className="font-serif text-xl text-gray-900">
                            {label}
                        </p>
                    </div>,
                    document.body,
                )}
            <WarningPopup
                open={!!warning}
                onClose={onWarningClose ?? (() => {})}
                message={warning}
            />
        </>
    );
}
