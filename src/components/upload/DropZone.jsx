import { useRef, useState } from 'react'
import { useToast } from '../ui/Toast'

export default function DropZone({ onFile }) {
  const inputRef = useRef()
  const [dragging, setDragging] = useState(false)
  const toast = useToast()

  const handleFiles = (files) => {
    if (!files || files.length === 0) return
    const arr = Array.from(files)
    const invalid = arr.filter(f => !['xlsx', 'xls', 'csv'].includes(f.name.split('.').pop().toLowerCase()))
    if (invalid.length) {
      toast.warn('Solo se aceptan archivos .xlsx, .xls o .csv')
      return
    }
    onFile(arr)
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    handleFiles(e.dataTransfer.files)
  }

  return (
    <div
      className={`dropzone${dragging ? ' drag-over' : ''}`}
      onClick={() => inputRef.current.click()}
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="dropzone__icon">📂</div>
      <div className="dropzone__text">
        Arrastra uno o varios archivos aquí, o haz clic para seleccionar
      </div>
      <div className="dropzone__hint">.xlsx · .xls · .csv · selección múltiple permitida</div>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        multiple
        style={{ display: 'none' }}
        onChange={e => handleFiles(e.target.files)}
      />
    </div>
  )
}
