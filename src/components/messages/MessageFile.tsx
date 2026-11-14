import { useState } from 'react'
import type { FileAttachment } from '../../services/chat/types.js'
import { touchAttachmentPreview, useAttachmentPreviews } from '../../services/attachmentPreviews.js'
import { FileCard } from '../files/FileCard.js'
import { Modal } from '../base/Modal.js'
import styles from './MessageFile.module.css'

/** 新图片可在当前页面临时查看；刷新、换设备或缓存回收后只显示元数据。 */
export const MessageFile = ({ file }: { file: FileAttachment; onRetry: (() => void) | null }) => {
  const id = file.attachmentId ?? file.id
  const url = useAttachmentPreviews((state) => state.entries[id]?.url)
  const [opened, setOpened] = useState(false)
  if (file.isImage && url) {
    return (
      <>
        <button
          type="button"
          className={`${styles.image} ${styles.imageThumb}`}
          title="查看本页临时原图；刷新或换设备后不可用"
          aria-label={`查看图片：${file.name}`}
          onClick={() => {
            touchAttachmentPreview(id)
            setOpened(true)
          }}
        >
          <img src={url} alt={file.name} loading="lazy" decoding="async" />
        </button>
        {opened ? (
          <Modal title={file.name} closable onClose={() => setOpened(false)}>
            <img
              src={url}
              decoding="async"
              alt={file.name}
              style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
            />
            <p>仅本页临时预览，请保留原文件；刷新或换设备后不提供下载或预览。</p>
          </Modal>
        ) : null}
      </>
    )
  }
  return (
    <div title="本页没有原件缓存；Files API 不提供原件下载，请保留自己的原始文件。">
      <FileCard name={file.name} size={file.size} />
      <small>仅附件信息；本页无原件预览，不提供下载</small>
    </div>
  )
}
