import { Router } from 'express'
import { state, saveRules } from '../lib/state.js'

const router = Router()

// GET /api/rules
router.get('/rules', (req, res) => {
  res.json({ rules: state.rules })
})

// PUT /api/rules — replace the full list
router.put('/rules', (req, res) => {
  const { rules } = req.body || {}
  if (!Array.isArray(rules)) {
    return res.status(400).json({ error: 'rules must be an array' })
  }
  state.rules = rules
  saveRules()
  res.json({ success: true, count: rules.length })
})

export default router
