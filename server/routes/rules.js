import { Router } from 'express'
import { state, saveRules } from '../lib/state.js'
import { validateRules } from '../lib/ruleSchema.js'

const router = Router()

// GET /api/rules
router.get('/rules', (req, res) => {
  res.json({ rules: state.rules })
})

// PUT /api/rules — replace the full list
router.put('/rules', (req, res) => {
  const checked = validateRules((req.body || {}).rules)
  if (!checked.ok) {
    return res.status(400).json({ error: checked.error })
  }
  state.rules = checked.rules
  saveRules()
  res.json({ success: true, count: checked.rules.length })
})

export default router
