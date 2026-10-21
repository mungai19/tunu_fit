'use strict';
// Seed workout library. Edit freely; the database is seeded once when the table is empty.
// place: 'home' | 'gym'   level: 'beginner' | 'intermediate' | 'advanced'   premium: 1 = paid plans only

const w = (title, place, focus, level, minutes, premium, exercises) => ({
  title, place, focus, level, minutes, premium, exercises,
});

module.exports = [
  // ---------- HOME (no gym needed) ----------
  w('Full Body Starter', 'home', 'Full body', 'beginner', 15, 0, [
    { name: 'Marching on the spot', detail: '1 min warm-up' },
    { name: 'Bodyweight squats', detail: '3 x 12' },
    { name: 'Incline or knee push-ups', detail: '3 x 8' },
    { name: 'Glute bridges', detail: '3 x 12' },
    { name: 'Plank', detail: '3 x 20 sec' },
    { name: 'Standing stretch', detail: '2 min cool-down' },
  ]),
  w('10-Minute Express', 'home', 'Full body', 'beginner', 10, 0, [
    { name: 'Jumping jacks (or step jacks)', detail: '40 sec' },
    { name: 'Squats', detail: '40 sec' },
    { name: 'Push-ups (knees ok)', detail: '40 sec' },
    { name: 'Reverse lunges', detail: '40 sec' },
    { name: 'Mountain climbers (slow)', detail: '40 sec' },
    { name: 'Repeat the circuit twice', detail: '20 sec rest between moves' },
  ]),
  w('Active Recovery & Mobility', 'home', 'Recovery', 'beginner', 15, 0, [
    { name: 'Cat-cow', detail: '10 slow reps' },
    { name: "Child's pose", detail: '45 sec' },
    { name: 'World\'s greatest stretch', detail: '5 each side' },
    { name: 'Hip flexor stretch', detail: '45 sec each side' },
    { name: 'Hamstring stretch', detail: '45 sec each side' },
    { name: 'Deep breathing', detail: '2 min' },
  ]),
  w('Core Foundations', 'home', 'Core', 'beginner', 15, 0, [
    { name: 'Dead bug', detail: '3 x 10' },
    { name: 'Bird dog', detail: '3 x 10' },
    { name: 'Forearm plank', detail: '3 x 25 sec' },
    { name: 'Bicycle crunches', detail: '3 x 16' },
    { name: 'Glute bridge hold', detail: '3 x 20 sec' },
  ]),
  w('Lower Body Burn', 'home', 'Legs & glutes', 'intermediate', 20, 1, [
    { name: 'Squat pulses', detail: '3 x 15' },
    { name: 'Reverse lunges', detail: '3 x 12 each' },
    { name: 'Single-leg glute bridge', detail: '3 x 12 each' },
    { name: 'Wall sit', detail: '3 x 40 sec' },
    { name: 'Calf raises', detail: '3 x 20' },
    { name: 'Donkey kicks', detail: '3 x 15 each' },
  ]),
  w('No-Equipment Cardio Blast', 'home', 'Cardio', 'intermediate', 20, 1, [
    { name: 'High knees', detail: '40 sec on / 20 off' },
    { name: 'Skater hops', detail: '40 / 20' },
    { name: 'Squat jumps', detail: '40 / 20' },
    { name: 'Burpees (no push-up)', detail: '40 / 20' },
    { name: 'Mountain climbers', detail: '40 / 20' },
    { name: 'Repeat the circuit 3 times', detail: '1 min rest between rounds' },
  ]),
  w('Upper Body Strength (Home)', 'home', 'Upper body', 'intermediate', 25, 1, [
    { name: 'Push-ups', detail: '4 x 10' },
    { name: 'Pike push-ups', detail: '3 x 8' },
    { name: 'Chair dips', detail: '3 x 10' },
    { name: 'Backpack rows (bag with books/water)', detail: '3 x 12' },
    { name: 'Plank shoulder taps', detail: '3 x 20' },
  ]),
  w('Tabata Fat Burner', 'home', 'HIIT', 'advanced', 20, 1, [
    { name: 'Warm-up jog on the spot', detail: '2 min' },
    { name: 'Jump squats', detail: '20 sec on / 10 off x 8' },
    { name: 'Burpees', detail: '20 / 10 x 8' },
    { name: 'Plank jacks', detail: '20 / 10 x 8' },
    { name: 'Cool-down stretch', detail: '3 min' },
  ]),

  // ---------- GYM ----------
  w('Gym Intro: Full Body Machines', 'gym', 'Full body', 'beginner', 40, 0, [
    { name: 'Treadmill warm-up', detail: '5 min easy' },
    { name: 'Leg press', detail: '3 x 12' },
    { name: 'Chest press machine', detail: '3 x 12' },
    { name: 'Seated row machine', detail: '3 x 12' },
    { name: 'Lat pulldown', detail: '3 x 12' },
    { name: 'Plank', detail: '3 x 30 sec' },
  ]),
  w('Gym Core & Abs', 'gym', 'Core', 'beginner', 25, 0, [
    { name: 'Cable crunch', detail: '3 x 15' },
    { name: 'Hanging knee raise', detail: '3 x 10' },
    { name: 'Pallof press', detail: '3 x 12 each' },
    { name: 'Ab wheel (or slow mountain climbers)', detail: '3 x 8' },
    { name: 'Side plank', detail: '3 x 25 sec each' },
  ]),
  w('Push Day', 'gym', 'Chest, shoulders, triceps', 'intermediate', 45, 1, [
    { name: 'Barbell or dumbbell bench press', detail: '4 x 8' },
    { name: 'Incline dumbbell press', detail: '3 x 10' },
    { name: 'Overhead shoulder press', detail: '3 x 10' },
    { name: 'Lateral raises', detail: '3 x 15' },
    { name: 'Cable triceps pushdown', detail: '3 x 12' },
  ]),
  w('Pull Day', 'gym', 'Back & biceps', 'intermediate', 45, 1, [
    { name: 'Lat pulldown or assisted pull-ups', detail: '4 x 8' },
    { name: 'Barbell or cable row', detail: '4 x 10' },
    { name: 'Face pulls', detail: '3 x 15' },
    { name: 'Dumbbell curls', detail: '3 x 12' },
    { name: 'Hammer curls', detail: '3 x 12' },
  ]),
  w('Leg Day', 'gym', 'Legs & glutes', 'intermediate', 50, 1, [
    { name: 'Back or goblet squat', detail: '4 x 8' },
    { name: 'Romanian deadlift', detail: '3 x 10' },
    { name: 'Walking lunges', detail: '3 x 12 each' },
    { name: 'Leg curl', detail: '3 x 12' },
    { name: 'Standing calf raise', detail: '4 x 15' },
  ]),
  w('Gym Cardio Intervals', 'gym', 'Cardio', 'beginner', 30, 0, [
    { name: 'Easy warm-up (bike or treadmill)', detail: '5 min' },
    { name: 'Hard effort', detail: '1 min' },
    { name: 'Easy recovery', detail: '2 min' },
    { name: 'Repeat hard/easy', detail: '6 rounds' },
    { name: 'Cool-down walk', detail: '4 min' },
  ]),
  w('Strength Full Body', 'gym', 'Full body', 'advanced', 55, 1, [
    { name: 'Deadlift', detail: '4 x 5' },
    { name: 'Barbell bench press', detail: '4 x 6' },
    { name: 'Barbell row', detail: '4 x 8' },
    { name: 'Front squat or leg press', detail: '3 x 8' },
    { name: 'Farmer carry', detail: '3 x 30 m' },
  ]),
  w('Upper Body Sculpt (Gym)', 'gym', 'Upper body', 'advanced', 45, 1, [
    { name: 'Incline bench press', detail: '4 x 8' },
    { name: 'Weighted pull-ups or lat pulldown', detail: '4 x 8' },
    { name: 'Arnold press', detail: '3 x 10' },
    { name: 'Cable fly', detail: '3 x 12' },
    { name: 'Superset curls + skullcrushers', detail: '3 x 12' },
  ]),
];
