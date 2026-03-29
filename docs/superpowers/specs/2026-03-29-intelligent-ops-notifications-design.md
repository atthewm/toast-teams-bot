# Intelligent Operations Notification System

## Overview

A tiered intelligence system that detects operational issues before, during, and after they happen across Remote Coffee's Toast, MarginEdge, M365, and external data sources. Two systems with clear lanes: the Teams bot handles real time (Tier 1 + Tier 2), the ops engine handles scheduled analysis (Tier 2 daily + Tier 3 weekly). Notifications are actionable, grouped to reduce noise, and auto create Planner tasks for accountability.

## Architecture

### System Roles

| System | Role | Cadence | Delivery |
|--------|------|---------|----------|
| toast-teams-bot | Real time intelligence | Every 2 min polling + scheduled checkpoints | Teams messages (existing channels) |
| remote-ops-engine | Predictive + retrospective analysis | Cron scheduled (daily, weekly) | Teams incoming webhooks (direct to channels) |

### Notification Tiers

**Tier 1 (Immediate)**: Fires within 2 minutes. Needs action now. Individual message per alert. Auto creates a Planner task (due 2h).

**Tier 2 (Next Checkpoint)**: Batched into scheduled checkpoint messages at 10:30 AM, 2:30 PM, and 6:30 PM alongside rush recaps. Important but can wait 1 to 3 hours. Escalates to Tier 1 if condition persists 30+ minutes.

**Tier 3 (Daily/Weekly Review)**: Deep analysis. Posted at 6:30 PM (daily) or Monday 6 AM (weekly). Patterns, trends, comparisons. Weekly action items auto create Planner tasks (due Friday).

### Channel Routing

Unchanged from current setup:
- #ops-control: Tier 1 alerts, Tier 2 checkpoints, server performance, staffing
- #finance: Revenue pacing, prime cost, labor %, executive summary
- #marketplace: Platform drought, platform mix shifts, competitor pricing

### Data Sources

| Source | Access Method | Data |
|--------|-------------|------|
| Toast Orders | toast-mcp-server (toast_list_orders) | Sales, voids, DT speed, channels, servers |
| Toast Labor | toast-mcp-server (toast_list_shifts) | Shifts, time entries, hours, OT, labor cost |
| MarginEdge | marginedge-mcp-server | Invoices, vendors, products, COGS |
| Microsoft Planner | remote-m365-mcp (planner_create_task) | Task creation from alerts |
| Google Reviews | Google Places API | Review count, ratings, review text |
| Competitor Menus | Firecrawl MCP (scrape) | Pricing on comparable items |
| Weather | OpenWeatherMap API | Current conditions, 5 day forecast |
| History Cache | toast-teams-bot disk (data/history/) | Daily summaries with sales, labor, DT, platforms |

## Tier 1: Immediate Alerts (toast-teams-bot)

### New Alerts

**1. Missed Clock Out**
- Trigger: 7:00 PM Central (store close + 30 min). Any employee with an open time entry (clockIn set, no clockOut).
- Message: "[Employee] is still clocked in from [time]. Auto clock out may fire. Verify or clock out manually."
- Channel: #ops-control
- Planner task: yes, due 1h
- Cooldown: once per employee per day

**2. Labor Cost Breach**
- Trigger: Checked hourly from 11 AM to 6 PM. Accumulated labor cost (from toast_list_shifts for today) divided by accumulated sales exceeds 35%.
- Message: "Labor is at [X]% of sales ($[labor] labor vs $[sales] revenue) with [N] hours remaining in the day."
- Channel: #ops-control, #finance
- Planner task: yes, due 2h
- Cooldown: 120 min

**3. Projected Daily Miss**
- Trigger: At noon. Projects end of day revenue from current pace vs trailing 4 week same day average. Fires if projected to miss by 25%+.
- Message: "[Day] is pacing at $[current] by noon. Projected finish: $[projected] vs $[average] average ([X]% below). Consider activating marketplace promos."
- Channel: #finance
- Planner task: yes, due 4h
- Cooldown: once per day

**4. New Negative Review**
- Trigger: Checked every 30 min during operating hours. New Google review with 1 or 2 stars.
- Message: "New [N] star Google review: '[first 100 chars]'. Respond promptly. Link: [url]"
- Channel: #ops-control
- Planner task: yes, due 2h
- Cooldown: per review (dedup by review ID)

### Upgraded Existing Alerts

**5. Smart Grouping**
- When multiple alerts fire in the same 2 min poll cycle, combine into a single message with sections.
- Format: "**Operations Update (2:14 PM)**" followed by sections for each alert type.
- Applies to: all existing Tier 1 alerts (void cluster, long open order, large order, DT speed)

**6. Escalation on Persistence**
- If a Tier 2 condition (DT drift, marketplace drought, slow period) persists for 30+ minutes without resolving, escalate to Tier 1.
- Message includes duration: "Drive thru has been 45s+ over target for 35 minutes."
- Escalated alerts create Planner tasks.

## Tier 2: Checkpoint Batches (toast-teams-bot)

Tier 2 items are collected between checkpoints and delivered as sections within the checkpoint message. Checkpoints run at 10:30 AM, 2:30 PM, and 6:30 PM. The existing rush recap becomes the "Rush Performance" section of the checkpoint.

### Checkpoint Message Format

```
**Ops Checkpoint** (10:30 AM, 3/29/2026)

**Morning Rush** (6 AM to 10 AM):
Orders: 42 (yesterday: 38, +11%)
Sales: $612 (yesterday: $558, +10%)
Peak: 7:15 to 7:30 (9 orders)

**Labor Status**:
Clocked in: 3 employees
Hours so far: 12.4h (0h OT)
Labor cost: $142 (23% of $618 sales). On target.

**Watches**:
Maria Delgado at 5.8h, approaching OT at 8h.
No DoorDash orders in 95 min (last: 8:55 AM).
Drive thru avg: 2:22 (8s under target).

**Weather**: 72F, clear. Normal sales expected.
```

### Tier 2 Items

**7. Overtime Watch**
- Track each employee's accumulated hours from today's time entries.
- Include in checkpoint when anyone crosses 6h in a shift.
- Escalate to Tier 1 if anyone crosses 8h (actual OT threshold).

**8. Staffing Gap Detection**
- Compare scheduled shifts vs actual time entries for today.
- If someone was scheduled but hasn't clocked in 15 min after shift start, include in next checkpoint.
- "Stephanie Lucas was scheduled at 11:30 AM, not yet clocked in (11:47 AM)."

**9. Real Time Labor Pacing**
- At each checkpoint, show labor cost as % of sales so far.
- Contextual, not an alert. "Labor through lunch: $185 (24% of $771 sales). On target." vs "Labor through lunch: $285 (37% of $771 sales). Above 30% target."

**10. Weather Context**
- At the 6 AM daily briefing and each checkpoint, include weather.
- At 6 AM: "Forecast: Rain expected after 2 PM. Your rainy afternoon average is 18% below normal. Consider reducing afternoon prep."
- At checkpoints: current conditions if notable (extreme heat, storms).

## Tier 3: Scheduled Analysis (remote-ops-engine)

All Tier 3 analyses are new modules in the ops engine. They post to Teams via incoming webhooks (one URL per channel, configured in `config/teams.json`).

### Daily Analysis (6:30 PM or 7:00 PM)

**11. Server Performance Ranker** (`src/analysis/server-performance.ts`)
- Runs daily at 7 PM after all time entries are finalized.
- For each employee who worked that day: avg DT speed, void count, sales volume handled, hours.
- Only surfaces notable findings (best, worst, anomalies).
- Channel: #ops-control
- Output: "Erika averaged 1:52 DT (fastest). Ashlea had 3 voids (highest). Stephanie handled $75/hour (most productive)."
- Data: Toast orders (DT timing, voids, server field) + Toast labor (time entries)

### Weekly Analysis (Monday 6 AM)

**12. Weekly Trend Analyzer** (`src/analysis/weekly-trends.ts`)
- Compares past 7 days vs 7 days before that across: total revenue, order count, avg ticket, labor %, void rate, DT speed, marketplace mix.
- Flags metrics that moved 10%+ in either direction.
- Channel: #finance
- Creates Planner tasks for any red flag items.

**13. Day of Week Decay Detector** (`src/analysis/day-decay.ts`)
- For each day of week with 4+ data points, checks for declining trend (3+ consecutive weeks down or negative regression slope at 10%+ annualized rate).
- Channel: #finance
- "Tuesdays have declined 4 consecutive weeks: $2,180 to $1,810. Investigate what changed."
- Activates: after 4 weeks of data.

**14. Labor Efficiency by Pattern** (`src/analysis/labor-patterns.ts`)
- Cross references staffing levels with sales outcomes by day of week.
- "2 person Saturdays average $1,900. 3 person Saturdays average $2,400."
- Channel: #ops-control
- Activates: after 4 weeks of labor data.

**15. Menu Mix Shift Detector** (`src/analysis/menu-mix.ts`)
- Compares item volume this week vs last week.
- Flags items with 30%+ volume change.
- Channel: #ops-control
- "Cold Brew down 35% (47 to 30 units). Matcha Latte up 42% (19 to 27 units)."
- Data: Requires item level data from orders (currently only itemCount is tracked; needs enhancement to track item names).

**16. Competitor Pricing** (`src/analysis/competitor-pricing.ts`)
- Weekly scrape of 3 to 5 nearby competitor menus from DoorDash/Uber Eats public pages.
- Uses Firecrawl MCP to scrape publicly visible menu pages.
- Tracks price changes on comparable items (drip coffee, lattes, cold brew, pastries).
- Channel: #marketplace
- "Blue Bottle raised latte price to $6.50 (you are at $5.75). Your pricing has room on specialty drinks."
- Competitors configured in `config/competitors.json` with names, platform URLs, and comparable item mapping.

**17. Google Review Summary** (`src/analysis/reviews.ts`)
- Weekly: rating trend (4 week rolling average), review velocity, common themes from recent negative reviews.
- Channel: #ops-control
- "Rating: 4.6 (stable). 3 new reviews this week. 1 negative mentioned slow drive thru on Tuesday."
- Real time negative review alerts are Tier 1 (handled by bot, see #4 above).
- Data: Google Places API (or Google Business Profile API if available).

**18. Weather Correlation** (`src/analysis/weather.ts`)
- Tags each daily summary with weather conditions (temp high/low, precipitation, conditions).
- After 4+ weeks, correlates weather with sales. Builds a simple model: rainy day avg, hot day avg, cold day avg vs normal.
- Monday forecast: "Rain expected Wednesday. Your rainy day average is $1,650 vs $2,100 normal."
- Daily at 6 AM: "Today: 92F, clear. Hot days average 12% above normal."
- Data: OpenWeatherMap free tier (current + 5 day forecast + historical via onecall).

**19. Weekly Executive Summary** (`src/analysis/executive-summary.ts`)
- Runs Monday 6 AM. Pulls from all other analyses.
- Structure: Wins (3 to 5 bullets), Misses (3 to 5 bullets), Key Metrics Table (revenue, orders, labor %, COGS %, void rate, DT speed, review rating), Trend Direction (improving/stable/declining), Action Items (specific, assigned, due Friday).
- Channel: #finance
- Action items auto create Planner tasks.
- Data: All other analysis outputs + history cache.

## Planner Task Integration

**Module**: New `src/routing/planner.ts` in the ops engine. New `src/tasks/planner.ts` in the bot.

Both systems create Planner tasks through the remote-m365-mcp server's `planner_create_task` tool.

**Task creation rules:**
| Trigger | Due | Assigned To | Plan |
|---------|-----|-------------|------|
| Tier 1 alert | 2 hours | Domain owner from owners.json | Ops |
| Tier 2 persists 3+ hours | Next business day | Domain owner | Ops |
| Tier 3 weekly action item | Friday | Domain owner | Ops |
| Negative review | 2 hours | ops owner | Ops |
| Competitor price opportunity | Friday | marketing owner | Marketing |

**Task fields**: Title = alert topic, Description = full alert text, Due = per table above, Assigned = per owners.json domain routing.

**Dedup**: Before creating a task, check if a task with the same title already exists in the plan (open/in progress). If so, add a comment to the existing task instead of creating a duplicate.

## Migration and Cleanup

**Bot control tower**: Disable the 3 control tower rule scheduler entries in `src/control-tower/scheduler.ts` (if wired) or confirm they remain disconnected. The ops engine owns all scheduled rule evaluation.

**Ops engine delivery**: Add `src/routing/teams-webhook.ts` that posts Adaptive Cards to Teams channels via incoming webhook URLs. Configure webhook URLs in `config/teams.json` alongside existing channel config.

**Shared thresholds**: The ops engine is the source of truth for thresholds (in `config/rules.json`). The bot uses intentionally higher thresholds for Tier 1 (35% labor for immediate alert vs 33% yellow in ops engine). This is by design: real time alerts should have a higher bar.

## Data Accumulation and Feature Activation

| Feature | Minimum Data Required | Auto Activates |
|---------|----------------------|----------------|
| Pattern matching (pace, deviation) | 1 week | Yes, already active |
| Day of week comparison | 2 weeks | Yes, already active |
| Weekly trend analysis | 2 weeks | Yes |
| Day of week decay detection | 4 weeks | Yes, checks on each run |
| Labor efficiency by pattern | 4 weeks of labor data | Yes, checks on each run |
| Weather correlation | 4 weeks of weather tagged data | Yes, checks on each run |
| Competitor pricing | 2 weeks of price snapshots | Yes |
| Server performance | 1 day | Yes |
| Review monitoring | Immediate | Yes |

## Files Changed

### toast-teams-bot (new files)
- `src/alerts/labor-realtime.ts`: Missed clock out, hourly labor breach, noon projection
- `src/alerts/checkpoint.ts`: Checkpoint message builder merging rush + Tier 2 batch
- `src/alerts/grouping.ts`: Smart grouping logic for combining same cycle alerts
- `src/alerts/escalation.ts`: Tier 2 to Tier 1 escalation tracker
- `src/alerts/reviews.ts`: Google review polling for Tier 1 negative review alerts
- `src/alerts/weather.ts`: Weather fetch and context for checkpoints
- `src/tasks/planner.ts`: Planner task creation via M365 MCP

### toast-teams-bot (modified files)
- `src/alerts/monitor.ts`: Integrate grouping, escalation, new labor alerts
- `src/scheduler/index.ts`: Replace rush recaps with checkpoints, add hourly labor check, noon projection, 7 PM clock out check, 30 min review poll
- `src/reports/index.ts`: Checkpoint format replaces rush recap format
- `src/cache/history.ts`: Already has labor fields (done this session)

### remote-ops-engine (new files)
- `src/analysis/weekly-trends.ts`: Week over week metric comparison
- `src/analysis/day-decay.ts`: Day of week declining trend detector
- `src/analysis/server-performance.ts`: Daily employee performance ranking
- `src/analysis/labor-patterns.ts`: Staffing level vs revenue correlation
- `src/analysis/menu-mix.ts`: Weekly item volume shift detection
- `src/analysis/competitor-pricing.ts`: Marketplace menu price scraping
- `src/analysis/reviews.ts`: Google review tracking and weekly summary
- `src/analysis/weather.ts`: Weather data fetching, tagging, and correlation
- `src/analysis/executive-summary.ts`: Monday morning digest
- `src/routing/teams-webhook.ts`: Direct Teams webhook poster
- `src/routing/planner.ts`: Planner task creation via M365 MCP
- `config/competitors.json`: Competitor names, URLs, item mapping
- `config/weather.json`: OpenWeatherMap API key, location coordinates

### remote-ops-engine (modified files)
- `src/rules/labor.ts`: Already wired (done this session)
- `src/rules/prime-cost.ts`: Already wired (done this session)
- `config/rules.json`: Add schedules for new analysis modules
- `config/teams.json`: Add incoming webhook URLs per channel
