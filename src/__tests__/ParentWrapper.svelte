<script lang="ts">
  import RecipientAutocomplete from '../components/RecipientAutocomplete.svelte'
  let value = $state('')
  export function setValue(v: string) {
    value = v
  }
</script>

<RecipientAutocomplete bind:value={value} />
