import { useState } from "react";
import { useTranslation } from "react-i18next";

interface ShareModalProps {
  bookId: string;
  onClose: () => void;
}

export function ShareModal({ bookId, onClose }: ShareModalProps) {
  const { t } = useTranslation();
  const [link, setLink] = useState<string>("");

  async function handleCopy() {
    await navigator.clipboard.writeText(link);
  }

  return (
    <div className="modal">
      <h2>{t("share.modal.title")}</h2>

      <div className="row">
        <input value={link} readOnly />
        <button onClick={handleCopy}>{t("share.modal.copyLink")}</button>
      </div>

      <div className="actions">
        <button onClick={onClose}>{t("common.cancel")}</button>
        <button onClick={onClose}>{t("common.confirm")}</button>
      </div>
    </div>
  );
}
