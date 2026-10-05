import type { DeviceAccess, PendingDevice } from "../api/remote";
import { PairingAnswer, PairingDetail, pairingQuestion } from "../remote/pairingRequest";
import { IconPhone } from "../ui/Icons";
import "../styles/pairing-prompt.css";

export default function PairingCards({
    pending,
    onAnswer,
}: {
    pending: readonly PendingDevice[];
    onAnswer: (id: string, allow: boolean, access: DeviceAccess) => void;
}) {
    return (
        <div className="pairing-prompts">
            {pending.map((request) => (
                <PairingCard key={request.id} request={request} onAnswer={(allow, access) => onAnswer(request.id, allow, access)} />
            ))}
        </div>
    );
}

function PairingCard({ request, onAnswer }: { request: PendingDevice; onAnswer: (allow: boolean, access: DeviceAccess) => void }) {
    const asking = pairingQuestion(request);
    return (
        <section className="pairing-prompt" role="alertdialog" aria-label={asking}>
            <div className="pairing-prompt-head">
                <span className="pairing-prompt-glyph" aria-hidden="true">
                    <IconPhone size={14} />
                </span>
                <span className="pairing-prompt-copy">
                    <span className="pairing-prompt-title">{asking}</span>
                    <span className="pairing-prompt-detail">
                        <PairingDetail request={request} />
                    </span>
                </span>
            </div>
            <PairingAnswer className="pairing-prompt-actions" onAnswer={onAnswer} />
        </section>
    );
}
