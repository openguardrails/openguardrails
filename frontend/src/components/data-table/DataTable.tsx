import * as React from "react"
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
  PaginationState,
} from "@tanstack/react-table"
import { ChevronLeft, ChevronRight } from "lucide-react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  pageCount?: number
  currentPage?: number
  pageSize?: number
  onPageChange?: (page: number) => void
  onPageSizeChange?: (pageSize: number) => void
  loading?: boolean
  pagination?: boolean
  emptyMessage?: string
  fillHeight?: boolean
  /** Enable horizontal scrolling with sticky last column (for action column) */
  stickyLastColumn?: boolean
}

export function DataTable<TData, TValue>({
  columns,
  data,
  pageCount = 0,
  currentPage = 1,
  pageSize = 10,
  onPageChange,
  onPageSizeChange,
  loading = false,
  pagination = true,
  emptyMessage = "No results found.",
  fillHeight = false,
  stickyLastColumn = false,
}: DataTableProps<TData, TValue>) {
  const [paginationState, setPaginationState] = React.useState<PaginationState>({
    pageIndex: currentPage - 1,
    pageSize: pageSize,
  })

  // Update pagination state when props change
  React.useEffect(() => {
    setPaginationState({
      pageIndex: currentPage - 1,
      pageSize: pageSize,
    })
  }, [currentPage, pageSize])

  const table = useReactTable({
    data,
    columns,
    pageCount: pageCount,
    state: {
      pagination: paginationState,
    },
    onPaginationChange: setPaginationState,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
  })

  // Handle page changes
  const handlePageChange = (newPage: number) => {
    if (onPageChange) {
      onPageChange(newPage)
    }
  }

  const handlePageSizeChange = (newPageSize: string) => {
    const size = parseInt(newPageSize)
    if (onPageSizeChange) {
      onPageSizeChange(size)
    }
    // Reset to first page when changing page size
    if (onPageChange) {
      onPageChange(1)
    }
  }

  const totalPages = pageCount || 1
  const canGoPrevious = currentPage > 1
  const canGoNext = currentPage < totalPages

  // Helper to determine if a column is the last one (for sticky positioning)
  const isLastColumn = (index: number, total: number) => stickyLastColumn && index === total - 1

  // Sticky column styles
  const stickyColumnStyle: React.CSSProperties = {
    position: 'sticky',
    right: 0,
    zIndex: 1,
  }

  const stickyHeaderStyle: React.CSSProperties = {
    position: 'sticky',
    right: 0,
    zIndex: 2,
  }

  return (
    <div className={fillHeight ? "h-full flex flex-col" : "space-y-4"}>
      <div className={`${fillHeight ? "flex-1 overflow-auto border-t" : "rounded-md border"} ${stickyLastColumn ? "overflow-x-auto" : ""}`}>
        <Table className={stickyLastColumn ? "min-w-max table-auto" : ""}>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header, index) => {
                  const isLast = isLastColumn(index, headerGroup.headers.length)
                  return (
                    <TableHead
                      key={header.id}
                      style={isLast ? stickyHeaderStyle : undefined}
                      className={isLast ? "bg-muted shadow-[-4px_0_8px_-4px_rgba(0,0,0,0.1)]" : ""}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center"
                >
                  <div className="flex items-center justify-center">
                    <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
                  </div>
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                >
                  {row.getVisibleCells().map((cell, index) => {
                    const isLast = isLastColumn(index, row.getVisibleCells().length)
                    return (
                      <TableCell
                        key={cell.id}
                        style={isLast ? stickyColumnStyle : undefined}
                        className={isLast ? "!bg-white shadow-[-4px_0_8px_-4px_rgba(0,0,0,0.1)]" : ""}
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext()
                        )}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {pagination && pageCount > 0 && (
        <div className={fillHeight ? "flex-shrink-0 flex items-center justify-between px-2 py-4 border-t bg-white" : "flex items-center justify-between px-2"}>
          <div className="flex items-center space-x-2">
            <p className="text-sm font-medium">Rows per page</p>
            <Select
              value={`${pageSize}`}
              onValueChange={handlePageSizeChange}
            >
              <SelectTrigger className="h-8 w-[70px]">
                <SelectValue placeholder={pageSize} />
              </SelectTrigger>
              <SelectContent side="top">
                {[10, 20, 30, 50, 100].map((size) => (
                  <SelectItem key={size} value={`${size}`}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center space-x-6 lg:space-x-8">
            <div className="flex w-[100px] items-center justify-center text-sm font-medium">
              Page {currentPage} of {totalPages}
            </div>
            <div className="flex items-center space-x-2">
              <Button
                variant="outline"
                className="h-8 w-8 p-0"
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={!canGoPrevious || loading}
              >
                <span className="sr-only">Go to previous page</span>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                className="h-8 w-8 p-0"
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={!canGoNext || loading}
              >
                <span className="sr-only">Go to next page</span>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
