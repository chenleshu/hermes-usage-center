import { createElement } from 'react'

let response
export const setJmsResponse = value => { response = value }
export const host = { state: {}, navigate() {} }
export const atom = initial => ({ get: () => initial })
export const useValue = store => store.get()
export const useQuery = () => response
export const useMutation = () => ({ isPending: false, mutate() {} })
export const useQueryClient = () => ({ invalidateQueries() {} })
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar'
export const STATUSBAR_AREAS = {}
export const PALETTE_AREA = 'palette'
export const haptic = () => {}
export const cn = (...names) => names.filter(Boolean).join(' ')
export const Button = ({ children, size, variant, ...props }) => createElement('button', props, children)
export const GlyphSpinner = () => createElement('span', null, 'loading')
export const Popover = ({ children }) => children
export const PopoverContent = Popover
export const PopoverTrigger = Popover
